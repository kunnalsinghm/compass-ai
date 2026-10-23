// seed.js - populates Compass with demo data for a fresh install.
//
// Unlike a fully synthetic seed, step 1 pulls REAL spend from Guard's
// database (run Guard's own `npm run seed` first) and generates real
// recommendations from it. Steps 2+ simulate evaluation/shadow-test
// history on top of those real recommendations so the dashboard shows a
// realistic spread of confidence states (cost-only, insufficient-sample,
// shadow-tested-similar, shadow-tested-diverges) rather than everything
// sitting at "cost-only" until real production traffic accumulates.

require("dotenv").config();

const db = require("./storage");
const guardDb = require("./guardDb");
const recommend = require("./recommend");
const rollout = require("./rollout");
const evaluation = require("./evaluation");
const cache = require("./cache");
const semanticCache = require("./semanticCache");
const { recordSaving } = require("./savings");
const { logAudit } = require("./audit");

async function main() {
  console.log("Connecting to Guard's database...");
  await guardDb.ready;

  console.log("Generating recommendations from Guard's real usage history...");
  const created = await recommend.generateRecommendations({ days: 30 });
  console.log(`  -> ${created.length} recommendation(s) generated: ${created.map((c) => `${c.provider}/${c.current_model}->${c.suggested_model}`).join(", ") || "(none - seed Guard first)"}`);

  if (created.length === 0) {
    console.log("No recommendations were generated - this usually means Guard has no usage_events yet. Run Guard's `npm run seed` first, then re-run this.");
  }

  const recs = await recommend.listRecommendations({});

  // Simulate evaluation history for each generated recommendation, with
  // a deliberately varied outcome per pair so the demo shows the full
  // confidence-state vocabulary rather than one flat result.
  const outcomePlan = ["good", "good", "good", "mixed", "none"]; // cycled across recommendations
  for (let i = 0; i < recs.length; i++) {
    const rec = recs[i];
    const outcome = outcomePlan[i % outcomePlan.length];
    if (outcome === "none") continue; // leave this one at cost-only, on purpose

    const sampleCount = outcome === "good" ? 8 : 3; // "mixed" stays under MIN_SAMPLES_FOR_CONFIDENCE deliberately
    for (let s = 0; s < sampleCount; s++) {
      const primaryText = `This is a representative primary-model answer #${s} for a ${rec.current_model} request.`;
      const goodCandidate = outcome === "good" && Math.random() > 0.15;
      const candidateText = goodCandidate
        ? `This is a representative primary-model answer #${s} for a ${rec.current_model} request, phrased slightly differently.`
        : `A noticeably different and lower-quality response, #${s}.`;

      const caseId = await evaluation.createEvaluationCase({
        source: "manual",
        provider: rec.provider,
        primaryModel: rec.current_model,
        candidateModel: rec.suggested_model,
        inputJson: { messages: [{ role: "user", content: `Demo prompt #${s}` }] },
        rubric: { type: "none" },
        team: "demo-seed",
      });

      // runEvaluation calls the real judge if COMPASS_JUDGE_API_KEY is
      // set; otherwise it degrades to lexical similarity only, which is
      // exactly the "no judge configured" path a real install would hit
      // too - so this seed exercises the same code either way.
      await evaluation.runEvaluation({
        caseId,
        provider: rec.provider,
        primaryModel: rec.current_model,
        candidateModel: rec.suggested_model,
        team: "demo-seed",
        primaryResponseJson: fakeResponse(rec.provider, primaryText),
        candidateResponseJson: fakeResponse(rec.provider, candidateText),
        primaryCostUsd: 0.01,
        candidateCostUsd: 0.002,
        rubric: null,
        inputSummary: `Demo prompt #${s}`,
      });
    }
    console.log(`  -> seeded ${sampleCount} evaluation sample(s) for ${rec.provider}/${rec.current_model}->${rec.suggested_model} (${outcome})`);
  }

  // Recompute recommendations now that evaluation evidence exists.
  await recommend.generateRecommendations({ days: 30 });

  // Approve the first "good" recommendation at a 5% canary so the
  // rollout ladder and tiered-economics report both have something live
  // to show.
  const refreshed = await recommend.listRecommendations({});
  const goodOne = refreshed.find((r) => r.confidence === "shadow-tested-similar");
  if (goodOne) {
    await rollout.approveRecommendation(goodOne.id, "seed-script", { rolloutPct: 5, note: "Demo seed: approved at 5% canary" });
    console.log(`  -> approved recommendation #${goodOne.id} (${goodOne.provider}/${goodOne.current_model}->${goodOne.suggested_model}) at 5% rollout`);
  }

  // A handful of cache hits, so cache.js's stats aren't empty on a fresh
  // dashboard load.
  console.log("Seeding cache activity...");
  for (let i = 0; i < 12; i++) {
    const provider = i % 2 === 0 ? "openai" : "anthropic";
    const model = provider === "openai" ? "gpt-4o-mini" : "claude-haiku";
    const body = { model, messages: [{ role: "user", content: `Frequently asked demo question #${i % 4}` }] };
    const cacheKey = cache.makeCacheKey({ provider, model, body, team: "demo-seed", customerId: null });
    await cache.setCached({
      cacheKey,
      provider,
      model,
      team: "demo-seed",
      customerId: null,
      responseJson: fakeResponse(provider, `Cached answer #${i % 4}`),
      input_tokens: 120,
      output_tokens: 60,
      costUsd: 0.0009,
      ttlSeconds: 3600,
    });
    if (i % 4 !== 0) await cache.getCached(cacheKey); // simulate a hit on repeat questions
  }

  await semanticCache.setSemanticCache({
    provider: "anthropic",
    model: "claude-sonnet",
    team: "demo-seed",
    customerId: null,
    body: { messages: [{ role: "user", content: "What's our refund policy for annual plans?" }] },
    responseJson: fakeResponse("anthropic", "Our refund policy for annual plans is..."),
    input_tokens: 200,
    output_tokens: 90,
    costUsd: 0.0021,
    ttlSeconds: 3600,
  });
  await semanticCache.findSemanticMatch({
    provider: "anthropic",
    model: "claude-sonnet",
    team: "demo-seed",
    customerId: null,
    body: { messages: [{ role: "user", content: "Could you explain the refund policy for an annual subscription?" }] },
  });

  await logAudit("seed-script", "seed_complete", null, { recommendations: created.length });

  console.log("\nSeed complete. Start Compass with `npm start` and open the dashboard.");
  process.exit(0);
}

function fakeResponse(provider, text) {
  if (provider === "anthropic") {
    return { content: [{ type: "text", text }], usage: { input_tokens: 100, output_tokens: 40 } };
  }
  return { choices: [{ message: { role: "assistant", content: text } }], usage: { prompt_tokens: 100, completion_tokens: 40 } };
}

// Seeding writes Compass tables and reads Guard's, so it needs a tenant context
// like any request. Single-tenant: the empty tenant. Multi-tenant: name one
// with COMPASS_SEED_TENANT_ID (a demo seed must not pick a customer for you).
async function seedInContext() {
  const tenantContext = require("./tenantContext");
  await guardDb.ready;
  if (!guardDb.MULTI_TENANT) return tenantContext.runWithTenant({}, main);
  const wanted = process.env.COMPASS_SEED_TENANT_ID;
  const tenants = await guardDb.listActiveTenants();
  const tenant = tenants.find((t) => String(t.id) === String(wanted));
  if (!tenant) throw new Error(`Multi-tenant Guard: set COMPASS_SEED_TENANT_ID to one of: ${tenants.map((t) => t.id).join(", ") || "(no active tenants)"}`);
  return tenantContext.runWithTenant({ tenantId: tenant.id, tenantSchema: tenant.schema_name }, main);
}

seedInContext().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
