// recommend.js - the recommendation engine (blueprint section 3.7).
// Every recommendation must be "concrete and financially defensible":
// current model, candidate model, affected traffic, current spend,
// estimated candidate spend, savings, evaluation evidence, and a
// confidence status that "must never imply more certainty than the
// evidence supports."
//
// Two separate concepts, deliberately not conflated:
//   - confidence: automated, evidence-derived (cost-only, insufficient-
//     sample, shadow-tested-similar, shadow-tested-diverges, human-
//     reviewed). Recomputed every time generateRecommendations() runs, as
//     more shadow-test/evaluation evidence accumulates.
//   - status: human workflow state (pending, approved, rejected,
//     rolled_back), changed ONLY by an explicit approval action
//     (rollout.js) - regenerating recommendations never silently
//     approves or un-approves anything.
//
// A recommendation's live routing_policy rollout_pct (once approved)
// determines the "approved for limited/production rollout" language the
// blueprint also lists in its confidence vocabulary - exposed here as
// `rollout_label` alongside the evidence-based `confidence`, rather than
// overloading one field with two different kinds of information.

const db = require("./storage");
const guardDb = require("./guardDb");
const pricing = require("./pricing");
const evaluation = require("./evaluation");
const { CHEAPER_ALTERNATIVES } = require("./modelTiers");

const MIN_TRAFFIC_EVENTS = Number(process.env.COMPASS_MIN_TRAFFIC_EVENTS) || 20;
const MIN_SAMPLES_FOR_CONFIDENCE = Number(process.env.COMPASS_MIN_EVAL_SAMPLES) || 5;
const SIMILARITY_THRESHOLD = Number(process.env.COMPASS_SIMILARITY_THRESHOLD) || 0.85;
const DETERMINISTIC_PASS_THRESHOLD = Number(process.env.COMPASS_DETERMINISTIC_PASS_THRESHOLD) || 0.9;
const MIN_HUMAN_REVIEW = Number(process.env.COMPASS_MIN_HUMAN_REVIEW) || 3;

function computeConfidence(evalStats) {
  if (!evalStats || evalStats.sample_count === 0) {
    return { confidence: "cost-only", caveat: "No shadow-test or evaluation evidence yet - savings estimate is cost math only." };
  }
  if (evalStats.sample_count < MIN_SAMPLES_FOR_CONFIDENCE) {
    return {
      confidence: "insufficient-sample",
      caveat: `Only ${evalStats.sample_count} evaluation sample(s) so far - need at least ${MIN_SAMPLES_FOR_CONFIDENCE} before quality can be assessed with any confidence.`,
    };
  }

  const acceptableHuman = (evalStats.human_labels?.acceptable || 0) + (evalStats.human_labels?.better || 0);
  const unacceptableHuman = (evalStats.human_labels?.unacceptable || 0) + (evalStats.human_labels?.unsafe || 0) + (evalStats.human_labels?.worse || 0);
  if (evalStats.human_review_sample_count >= MIN_HUMAN_REVIEW) {
    if (unacceptableHuman === 0 && acceptableHuman > 0) {
      return {
        confidence: "human-reviewed",
        caveat: `${evalStats.human_review_sample_count} human-reviewed sample(s), no unacceptable/unsafe labels.`,
      };
    }
    if (unacceptableHuman > 0) {
      return {
        confidence: "shadow-tested-diverges",
        caveat: `${unacceptableHuman} of ${evalStats.human_review_sample_count} human-reviewed sample(s) were rated unacceptable, unsafe, or worse than baseline.`,
      };
    }
  }

  const qualitySignal = evalStats.avg_judge_score ?? evalStats.avg_lexical_similarity;
  const deterministicOk = evalStats.deterministic_pass_rate === null || evalStats.deterministic_pass_rate >= DETERMINISTIC_PASS_THRESHOLD;

  if (qualitySignal !== null && qualitySignal >= SIMILARITY_THRESHOLD && deterministicOk) {
    return {
      confidence: "shadow-tested-similar",
      caveat: `${evalStats.sample_count} sample(s), ${evalStats.avg_judge_score !== null ? `${evalStats.avg_judge_score} avg judge score` : `${evalStats.avg_lexical_similarity} avg lexical similarity (no judge configured)`}${
        evalStats.deterministic_checked_count ? `, ${Math.round(evalStats.deterministic_pass_rate * 100)}% deterministic pass rate` : ""
      }.`,
    };
  }

  return {
    confidence: "shadow-tested-diverges",
    caveat: `${evalStats.sample_count} sample(s) evaluated, but quality/deterministic signals fall below the ${SIMILARITY_THRESHOLD} similarity / ${DETERMINISTIC_PASS_THRESHOLD} deterministic-pass thresholds.`,
  };
}

function rolloutLabelFor(policy) {
  if (!policy) return null;
  if (policy.status === "rejected") return "rejected";
  if (policy.status === "rolled_back") return "rolled-back";
  if (policy.rollout_pct >= 50) return "approved-for-production";
  if (policy.rollout_pct >= 1) return "approved-for-limited-rollout";
  return "approved-shadow-only";
}

// Regenerates every model-switch recommendation from current Guard spend
// data + current Compass evaluation evidence. Safe to call repeatedly
// (e.g. on a schedule, or on-demand from the dashboard) - it upserts by
// (provider, current_model, suggested_model) and never touches `status`.
async function generateRecommendations({ days = 30 } = {}) {
  const spend = await guardDb.getSpendByModel({ days });
  const created = [];

  for (const row of spend) {
    const key = `${row.provider}/${row.model}`;
    const alt = CHEAPER_ALTERNATIVES[key];
    if (!alt) continue;

    const affectedEvents = Number(row.event_count) || 0;
    const currentCost = Number(row.total_cost) || 0;

    const suggestedCostEstimate = await pricing.computeCost({
      provider: alt.provider,
      model: alt.model,
      input_tokens: row.input_tokens,
      output_tokens: row.output_tokens,
    });

    const evalStats = await evaluation.getEvaluationStatsForPair(row.provider, row.model, alt.model);
    let { confidence, caveat } = computeConfidence(evalStats);

    if (affectedEvents < MIN_TRAFFIC_EVENTS) {
      caveat = `Only ${affectedEvents} request(s) in the last ${days} days for this model - too little traffic for a reliable estimate. ${caveat}`;
    }

    const estimatedSuggestedCost = suggestedCostEstimate.rate_found ? suggestedCostEstimate.cost_usd : null;
    const estimatedSavings = estimatedSuggestedCost !== null ? Math.round((currentCost - estimatedSuggestedCost) * 100) / 100 : null;
    const estimatedSavingsPct = estimatedSavings !== null && currentCost > 0 ? Math.round((estimatedSavings / currentCost) * 1000) / 10 : null;

    const evidence = {
      window_days: days,
      affected_events: affectedEvents,
      evaluation: evalStats,
      pricing_source: suggestedCostEstimate.source || null,
    };

    await db.run(
      `INSERT INTO recommendations
         (provider, current_model, suggested_model, window_days, current_cost_usd, estimated_suggested_cost_usd,
          estimated_savings_usd, estimated_savings_pct, affected_events, confidence, caveat, evidence_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider, current_model, suggested_model) DO UPDATE SET
         window_days = excluded.window_days,
         current_cost_usd = excluded.current_cost_usd,
         estimated_suggested_cost_usd = excluded.estimated_suggested_cost_usd,
         estimated_savings_usd = excluded.estimated_savings_usd,
         estimated_savings_pct = excluded.estimated_savings_pct,
         affected_events = excluded.affected_events,
         confidence = excluded.confidence,
         caveat = excluded.caveat,
         evidence_json = excluded.evidence_json,
         updated_at = ${db.dialect === "postgres" ? "NOW()" : "datetime('now')"}`,
      [row.provider, row.model, alt.model, days, currentCost, estimatedSuggestedCost, estimatedSavings, estimatedSavingsPct, affectedEvents, confidence, caveat, JSON.stringify(evidence)]
    );

    // Ensure a shadow-only routing policy exists the moment a
    // recommendation exists at all, per blueprint 3.9's rollout ladder
    // starting at "0% -> shadow only." Never created at nonzero rollout -
    // only an explicit approval (rollout.js) advances it.
    await db.run(
      `INSERT INTO routing_policies (scope_type, scope_value, provider, from_model, to_model, rollout_pct, status)
       VALUES ('global', NULL, ?, ?, ?, 0, 'shadow')
       ON CONFLICT(scope_type, scope_value, provider, from_model) DO NOTHING`,
      [row.provider, row.model, alt.model]
    );

    created.push({ provider: row.provider, current_model: row.model, suggested_model: alt.model, confidence });
  }

  return created;
}

async function listRecommendations({ status } = {}) {
  const recs = status
    ? await db.all(`SELECT * FROM recommendations WHERE status = ? ORDER BY estimated_savings_usd DESC NULLS LAST`, [status])
    : await db.all(`SELECT * FROM recommendations ORDER BY estimated_savings_usd DESC`);

  const enriched = [];
  for (const rec of recs) {
    const policy = await db.get(`SELECT * FROM routing_policies WHERE provider = ? AND from_model = ?`, [rec.provider, rec.current_model]);
    enriched.push({
      ...rec,
      evidence: rec.evidence_json ? JSON.parse(rec.evidence_json) : null,
      rollout_pct: policy?.rollout_pct ?? 0,
      rollout_label: rolloutLabelFor(policy),
      routing_policy_id: policy?.id ?? null,
    });
  }
  return enriched;
}

async function getRecommendation(id) {
  const rec = await db.get(`SELECT * FROM recommendations WHERE id = ?`, [id]);
  if (!rec) return null;
  const policy = await db.get(`SELECT * FROM routing_policies WHERE provider = ? AND from_model = ?`, [rec.provider, rec.current_model]);
  return {
    ...rec,
    evidence: rec.evidence_json ? JSON.parse(rec.evidence_json) : null,
    rollout_pct: policy?.rollout_pct ?? 0,
    rollout_label: rolloutLabelFor(policy),
    routing_policy_id: policy?.id ?? null,
  };
}

module.exports = {
  generateRecommendations,
  listRecommendations,
  getRecommendation,
  computeConfidence,
  rolloutLabelFor,
  MIN_TRAFFIC_EVENTS,
  MIN_SAMPLES_FOR_CONFIDENCE,
};
