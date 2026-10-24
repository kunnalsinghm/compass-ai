// rollout.js - approval workflow + rollout percentage state machine,
// blueprint section 3.9. The ladder is exactly the blueprint's:
//   0% -> shadow only, 1% -> canary, 5-25% -> limited/controlled
//   production, 50% -> majority rollout, 100% -> full migration.
// router.js is what actually samples live traffic against
// routing_policies.rollout_pct - this module only ever changes that
// number (and the audit trail around it).
//
// Automatic rollback (checkAutoRollbackConditions) re-evaluates every
// currently-live policy's evidence and rolls it back to 0% the moment
// quality evidence degrades below the same threshold recommend.js uses to
// grant confidence in the first place - "the circuit breaker itself must
// be independently reliable" (blueprint 4.8) is honored here by NOT
// depending on the router or the recommendation the policy came from:
// this reads evaluation_results directly.

const db = require("./storage");
const { logAudit } = require("./audit");
const { computeConfidence, evidenceGate, CANARY_MAX_PCT } = require("./recommend");
const evaluation = require("./evaluation");
const logger = require("./logger");
const { tenantKey } = require("./tenantContext");

const ROLLOUT_LADDER = [0, 1, 5, 25, 50, 100];


function statusForPct(pct) {
  if (pct <= 0) return "shadow";
  if (pct === 1) return "canary";
  if (pct <= 25) return "limited";
  if (pct < 100) return "majority";
  return "full";
}

async function getPolicyForRecommendation(rec) {
  return db.get(`SELECT * FROM routing_policies WHERE tenant_key = ? AND provider = ? AND from_model = ?`, [tenantKey(), rec.provider, rec.current_model]);
}

async function approveRecommendation(recommendationId, actor, { rolloutPct = 1, note } = {}) {
  if (!ROLLOUT_LADDER.includes(rolloutPct)) {
    throw new Error(`rolloutPct must be one of ${ROLLOUT_LADDER.join(", ")}`);
  }
  const rec = await db.get(`SELECT * FROM recommendations WHERE id = ? AND tenant_key = ?`, [recommendationId, tenantKey()]);
  if (!rec) throw new Error(`Recommendation ${recommendationId} not found`);
  if (rec.status === "rejected") throw new Error("Cannot approve a rejected recommendation - create a new one instead");

  await db.run(`UPDATE recommendations SET status = 'approved', updated_at = ${nowExpr()} WHERE id = ? AND tenant_key = ?`, [recommendationId, tenantKey()]);
  await db.run(
    `UPDATE routing_policies SET rollout_pct = ?, status = ?, recommendation_id = ?, updated_at = ${nowExpr()}
     WHERE tenant_key = ? AND provider = ? AND from_model = ?`,
    [rolloutPct, statusForPct(rolloutPct), recommendationId, tenantKey(), rec.provider, rec.current_model]
  );
  await db.run(`INSERT INTO approvals (tenant_key, recommendation_id, action, actor, note, rollout_pct) VALUES (?, ?, 'approve', ?, ?, ?)`, [
    tenantKey(),
    recommendationId,
    actor,
    note || null,
    rolloutPct,
  ]);
  await logAudit(actor, "approve_recommendation", `recommendation:${recommendationId}`, { rolloutPct, note });

  logger.info("Recommendation approved", { recommendationId, actor, rolloutPct, provider: rec.provider, from: rec.current_model, to: rec.suggested_model });
  return getPolicyForRecommendation(rec);
}

async function rejectRecommendation(recommendationId, actor, { note } = {}) {
  const rec = await db.get(`SELECT * FROM recommendations WHERE id = ? AND tenant_key = ?`, [recommendationId, tenantKey()]);
  if (!rec) throw new Error(`Recommendation ${recommendationId} not found`);

  await db.run(`UPDATE recommendations SET status = 'rejected', updated_at = ${nowExpr()} WHERE id = ? AND tenant_key = ?`, [recommendationId, tenantKey()]);
  await db.run(
    `UPDATE routing_policies SET rollout_pct = 0, status = 'rejected', updated_at = ${nowExpr()} WHERE tenant_key = ? AND provider = ? AND from_model = ?`,
    [tenantKey(), rec.provider, rec.current_model]
  );
  await db.run(`INSERT INTO approvals (tenant_key, recommendation_id, action, actor, note, rollout_pct) VALUES (?, ?, 'reject', ?, ?, 0)`, [
    tenantKey(),
    recommendationId,
    actor,
    note || null,
  ]);
  await logAudit(actor, "reject_recommendation", `recommendation:${recommendationId}`, { note });
  logger.info("Recommendation rejected", { recommendationId, actor });
}

async function advanceRollout(recommendationId, actor, newPct, { note, override = false } = {}) {
  if (!ROLLOUT_LADDER.includes(newPct)) {
    throw new Error(`newPct must be one of ${ROLLOUT_LADDER.join(", ")}`);
  }
  const rec = await db.get(`SELECT * FROM recommendations WHERE id = ? AND tenant_key = ?`, [recommendationId, tenantKey()]);
  if (!rec) throw new Error(`Recommendation ${recommendationId} not found`);
  if (rec.status !== "approved") throw new Error(`Recommendation must be approved before its rollout can be advanced (current status: ${rec.status})`);

  let overridden = false;
  if (newPct > CANARY_MAX_PCT) {
    const gate = evidenceGate(await evaluation.getEvaluationStatsForPair(rec.provider, rec.current_model, rec.suggested_model));
    const problems = gate.problems;
    if (problems.length) {
      if (!(override && note)) {
        throw new Error(`Cannot go above ${CANARY_MAX_PCT}%: ${problems.join("; ")}. Keep gathering evidence, or pass override=true with a note explaining why.`);
      }
      overridden = true;
    }
  }

  await db.run(
    `UPDATE routing_policies SET rollout_pct = ?, status = ?, updated_at = ${nowExpr()} WHERE tenant_key = ? AND provider = ? AND from_model = ?`,
    [newPct, statusForPct(newPct), tenantKey(), rec.provider, rec.current_model]
  );
  await db.run(`INSERT INTO approvals (tenant_key, recommendation_id, action, actor, note, rollout_pct) VALUES (?, ?, 'advance_rollout', ?, ?, ?)`, [
    tenantKey(),
    recommendationId,
    actor,
    overridden ? `[evidence gate overridden] ${note}` : note || null,
    newPct,
  ]);
  await logAudit(actor, "advance_rollout", `recommendation:${recommendationId}`, { newPct, note, overridden });
  logger.info("Rollout advanced", { recommendationId, actor, newPct });
  return getPolicyForRecommendation(rec);
}

async function rollback(recommendationId, actor, { note, automatic = false } = {}) {
  const rec = await db.get(`SELECT * FROM recommendations WHERE id = ? AND tenant_key = ?`, [recommendationId, tenantKey()]);
  if (!rec) throw new Error(`Recommendation ${recommendationId} not found`);

  await db.run(`UPDATE recommendations SET status = 'rolled_back', updated_at = ${nowExpr()} WHERE id = ? AND tenant_key = ?`, [recommendationId, tenantKey()]);
  await db.run(
    `UPDATE routing_policies SET rollout_pct = 0, status = 'rolled_back', updated_at = ${nowExpr()} WHERE tenant_key = ? AND provider = ? AND from_model = ?`,
    [tenantKey(), rec.provider, rec.current_model]
  );
  await db.run(`INSERT INTO approvals (tenant_key, recommendation_id, action, actor, note, rollout_pct) VALUES (?, ?, 'rollback', ?, ?, 0)`, [
    tenantKey(),
    recommendationId,
    actor,
    note || null,
  ]);
  await logAudit(actor, automatic ? "auto_rollback" : "rollback", `recommendation:${recommendationId}`, { note, automatic });
  logger.warn(automatic ? "Rollout AUTOMATICALLY rolled back" : "Rollout rolled back", { recommendationId, actor, note });
}

// Blueprint 4.8-style safety net, scoped to Compass's own domain (cost
// routing quality, not agent runaway loops - that's Autopilot's job in
// the full FinOps Trinity). Re-scores every live (rollout_pct > 0, not
// already rejected/rolled_back) policy against fresh evaluation evidence
// and rolls back anything whose confidence has degraded to
// 'shadow-tested-diverges'. Intended to be called on a schedule (see
// server/index.js) as well as on-demand via POST /api/rollout/auto-check.
async function checkAutoRollbackConditions() {
  const livePolicies = await db.all(`SELECT * FROM routing_policies WHERE tenant_key = ? AND rollout_pct > 0 AND status NOT IN ('rejected','rolled_back')`, [tenantKey()]);
  const rolledBack = [];

  for (const policy of livePolicies) {
    if (!policy.recommendation_id) continue;
    const evalStats = await evaluation.getEvaluationStatsForPair(policy.provider, policy.from_model, policy.to_model);
    const { confidence } = computeConfidence(evalStats);
    if (confidence === "shadow-tested-diverges") {
      await rollback(policy.recommendation_id, "system:auto-rollback", {
        note: `Automatic rollback: fresh evaluation evidence now shows 'shadow-tested-diverges' (${evalStats.sample_count} samples).`,
        automatic: true,
      });
      rolledBack.push({ recommendationId: policy.recommendation_id, provider: policy.provider, from: policy.from_model, to: policy.to_model });
    }
  }
  return rolledBack;
}

function nowExpr() {
  return db.dialect === "postgres" ? "NOW()" : "datetime('now')";
}

module.exports = {
  ROLLOUT_LADDER,
  statusForPct,
  approveRecommendation,
  rejectRecommendation,
  advanceRollout,
  rollback,
  checkAutoRollbackConditions,
};
