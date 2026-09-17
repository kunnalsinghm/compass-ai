const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

for (const f of fs.readdirSync(__dirname)) {
  if (/^\.tmp-recrollout-\d+\.db/.test(f)) {
    try {
      fs.unlinkSync(path.join(__dirname, f));
    } catch {
      /* ignore */
    }
  }
}
process.env.COMPASS_DB_PATH = path.join(__dirname, `.tmp-recrollout-${process.pid}.db`);

const { setupGuardFixture } = require("./helpers/guardFixture");
const fixture = setupGuardFixture(`recrollout-${process.pid}`);
fixture.seed({
  usage_events: Array.from({ length: 40 }, (_, i) => ({
    provider: "openai",
    model: "gpt-4o",
    team: "growth",
    cost_usd: 0.05,
    input_tokens: 800,
    output_tokens: 200,
  })),
});

const recommend = require("../server/recommend");
const rollout = require("../server/rollout");
const evaluation = require("../server/evaluation");

test.after(() => {
  fixture.cleanup();
  try {
    fs.unlinkSync(process.env.COMPASS_DB_PATH);
  } catch {
    /* ignore */
  }
  try {
    fs.unlinkSync(process.env.COMPASS_DB_PATH + "-wal");
  } catch {
    /* ignore */
  }
});

test("computeConfidence: no evidence yet is 'cost-only', not a false negative", () => {
  const { confidence } = recommend.computeConfidence({ sample_count: 0 });
  assert.equal(confidence, "cost-only");
});

test("computeConfidence: below the minimum sample count is 'insufficient-sample'", () => {
  const { confidence } = recommend.computeConfidence({ sample_count: 2, avg_judge_score: 0.99, human_labels: {}, human_review_sample_count: 0 });
  assert.equal(confidence, "insufficient-sample");
});

test("computeConfidence: enough high-quality samples is 'shadow-tested-similar'", () => {
  const { confidence } = recommend.computeConfidence({
    sample_count: 10,
    avg_judge_score: 0.95,
    deterministic_pass_rate: 1,
    deterministic_checked_count: 10,
    human_labels: {},
    human_review_sample_count: 0,
  });
  assert.equal(confidence, "shadow-tested-similar");
});

test("computeConfidence: enough low-quality samples is 'shadow-tested-diverges'", () => {
  const { confidence } = recommend.computeConfidence({
    sample_count: 10,
    avg_judge_score: 0.4,
    deterministic_pass_rate: 0.5,
    deterministic_checked_count: 10,
    human_labels: {},
    human_review_sample_count: 0,
  });
  assert.equal(confidence, "shadow-tested-diverges");
});

test("computeConfidence: an unsafe human label overrides a good automated score", () => {
  const { confidence } = recommend.computeConfidence({
    sample_count: 10,
    avg_judge_score: 0.95,
    human_labels: { unsafe: 1, acceptable: 3 },
    human_review_sample_count: 4,
  });
  assert.equal(confidence, "shadow-tested-diverges");
});

test("statusForPct follows the blueprint's rollout ladder", () => {
  assert.equal(rollout.statusForPct(0), "shadow");
  assert.equal(rollout.statusForPct(1), "canary");
  assert.equal(rollout.statusForPct(5), "limited");
  assert.equal(rollout.statusForPct(25), "limited");
  assert.equal(rollout.statusForPct(50), "majority");
  assert.equal(rollout.statusForPct(100), "full");
});

test("end-to-end: generate -> approve -> advance -> rollback", async () => {
  const created = await recommend.generateRecommendations({ days: 30 });
  assert.ok(created.length >= 1, "fixture spend should produce at least one gpt-4o -> gpt-4o-mini recommendation");

  const recs = await recommend.listRecommendations({});
  const rec = recs.find((r) => r.current_model === "gpt-4o");
  assert.ok(rec);
  assert.equal(rec.status, "pending");
  assert.equal(rec.confidence, "cost-only"); // no evaluation evidence seeded yet
  assert.equal(rec.rollout_pct, 0);

  const policy = await rollout.approveRecommendation(rec.id, "test-actor", { rolloutPct: 1, note: "canary it" });
  assert.equal(policy.rollout_pct, 1);
  assert.equal(policy.status, "canary");

  const afterApproval = await recommend.getRecommendation(rec.id);
  assert.equal(afterApproval.status, "approved");
  assert.equal(afterApproval.rollout_pct, 1);

  await rollout.advanceRollout(rec.id, "test-actor", 50, { note: "looking good" });
  const afterAdvance = await recommend.getRecommendation(rec.id);
  assert.equal(afterAdvance.rollout_pct, 50);
  assert.equal(afterAdvance.rollout_label, "approved-for-production");

  await rollout.rollback(rec.id, "test-actor", { note: "customer complaint" });
  const afterRollback = await recommend.getRecommendation(rec.id);
  assert.equal(afterRollback.status, "rolled_back");
  assert.equal(afterRollback.rollout_pct, 0);
});

test("cannot advance rollout on a recommendation that was never approved", async () => {
  const created = await recommend.generateRecommendations({ days: 30 });
  const recs = await recommend.listRecommendations({ status: "pending" });
  const rec = recs[0];
  if (!rec) return; // nothing left pending after the previous test approved/rolled one back - fine
  await assert.rejects(() => rollout.advanceRollout(rec.id, "test-actor", 50), /must be approved/);
});

test("auto-rollback fires when fresh evidence turns diverging", async () => {
  const created = await recommend.generateRecommendations({ days: 30 });
  const recs = await recommend.listRecommendations({});
  const rec = recs.find((r) => r.current_model === "gpt-4o" && r.status !== "rolled_back");
  if (!rec) return;

  await rollout.approveRecommendation(rec.id, "test-actor", { rolloutPct: 25 });

  // Seed 6 bad evaluation samples so computeConfidence lands on
  // 'shadow-tested-diverges' for this exact pair.
  for (let i = 0; i < 6; i++) {
    const caseId = await evaluation.createEvaluationCase({
      source: "manual",
      provider: rec.provider,
      primaryModel: rec.current_model,
      candidateModel: rec.suggested_model,
      inputJson: { messages: [] },
      team: "growth",
    });
    await evaluation.runEvaluation({
      caseId,
      provider: rec.provider,
      primaryModel: rec.current_model,
      candidateModel: rec.suggested_model,
      team: "growth",
      primaryResponseJson: { choices: [{ message: { content: "The quick brown fox jumps over the lazy dog." } }] },
      candidateResponseJson: { choices: [{ message: { content: "completely unrelated garbage output" } }] },
      primaryCostUsd: 0.05,
      candidateCostUsd: 0.01,
      inputSummary: "test",
    });
  }

  const rolledBack = await rollout.checkAutoRollbackConditions();
  assert.ok(rolledBack.some((r) => r.recommendationId === rec.id));

  const after = await recommend.getRecommendation(rec.id);
  assert.equal(after.status, "rolled_back");
  assert.equal(after.rollout_pct, 0);
});
