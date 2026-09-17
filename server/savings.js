// savings.js - the savings ledger (every dollar Compass claims credit
// for, itemized) and the tiered economics report (the blueprint's
// three-scenario comparison: all-premium vs. recommended routing vs.
// aggressive routing). Never claims a theoretical saving as realized -
// see recordSaving's net_savings_usd = gross - overhead formula.

const db = require("./storage");
const guardDb = require("./guardDb");
const { computeCost } = require("./pricing");
const { sinceDaysAgo } = require("./storage/dialectSql");
const { TIER_LADDER, cheapestModel } = require("./modelTiers");

async function recordSaving({ kind, provider, model, team, customerId, grossSavingsUsd, overheadUsd = 0, referenceId }) {
  const gross = Number(grossSavingsUsd) || 0;
  const overhead = Number(overheadUsd) || 0;
  const net = Math.round((gross - overhead) * 1e6) / 1e6;
  await db.run(
    `INSERT INTO savings_ledger (kind, provider, model, team, customer_id, gross_savings_usd, overhead_usd, net_savings_usd, reference_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [kind, provider || null, model || null, team || null, customerId || null, gross, overhead, net, referenceId || null]
  );
}

async function getSavingsSummary({ days = 30 } = {}) {
  const since = sinceDaysAgo(days);
  const byKind = await db.all(
    `SELECT kind, COUNT(*) AS events, COALESCE(SUM(gross_savings_usd),0) AS gross, COALESCE(SUM(net_savings_usd),0) AS net
     FROM savings_ledger WHERE created_at >= ${since} GROUP BY kind`
  );
  const total = await db.get(
    `SELECT COALESCE(SUM(net_savings_usd),0) AS net_savings_usd, COUNT(*) AS events
     FROM savings_ledger WHERE created_at >= ${since}`
  );
  return {
    window_days: days,
    total_net_savings_usd: round2(total?.net_savings_usd),
    total_events: Number(total?.events || 0),
    by_kind: byKind.map((r) => ({
      kind: r.kind,
      events: Number(r.events),
      gross_savings_usd: round2(r.gross),
      net_savings_usd: round2(r.net),
    })),
  };
}

// ---------------------------------------------------------------------
// Tiered economics report - blueprint section 3.10. Shows the SAME real
// traffic under three policies so the cost/quality trade-off is visible
// rather than a single unsupported savings percentage:
//   1. all_premium         - every request had used the top tier
//   2. recommended_routing - approved recommendations applied at their
//                            current rollout percentage (i.e. what's
//                            ACTUALLY happening right now)
//   3. aggressive_routing  - every request used the cheapest tier
//
// Quality scores are proxied by average evaluation judge_score for each
// pair where evaluation data exists; scenarios with no evaluation
// evidence report quality_score: null rather than inventing a number.
// ---------------------------------------------------------------------
async function getTieredEconomicsReport({ days = 30 } = {}) {
  const spend = await guardDb.getSpendByModel({ days });

  let allPremiumCost = 0;
  let recommendedCost = 0;
  let aggressiveCost = 0;
  let baselineCost = 0;

  const approvedPolicies = await db.all(
    `SELECT * FROM routing_policies WHERE status NOT IN ('rejected','rolled_back')`
  );
  const policyByKey = {};
  for (const p of approvedPolicies) {
    policyByKey[`${p.provider}/${p.from_model}`] = p;
  }

  for (const row of spend) {
    const provider = row.provider;
    const model = row.model;
    baselineCost += Number(row.total_cost) || 0;

    // Scenario 1: every request had used this provider's premium tier.
    const ladder = TIER_LADDER[provider] || [];
    const premiumModel = ladder[ladder.length - 1]?.model || model;
    const premiumRate = await computeCost({
      provider,
      model: premiumModel,
      input_tokens: row.input_tokens,
      output_tokens: row.output_tokens,
    });
    allPremiumCost += premiumRate.rate_found ? premiumRate.cost_usd : Number(row.total_cost) || 0;

    // Scenario 2: recommended routing - blend actual cost at
    // (1 - rollout_pct) with the approved cheaper model's cost at
    // rollout_pct, i.e. what a canary/limited rollout actually spends.
    const policy = policyByKey[`${provider}/${model}`];
    if (policy && policy.rollout_pct > 0) {
      const pct = Math.min(100, Math.max(0, policy.rollout_pct)) / 100;
      const switchedTokensInput = row.input_tokens * pct;
      const switchedTokensOutput = row.output_tokens * pct;
      const remainingInput = row.input_tokens * (1 - pct);
      const remainingOutput = row.output_tokens * (1 - pct);
      const switchedRate = await computeCost({
        provider: policy.provider,
        model: policy.to_model,
        input_tokens: switchedTokensInput,
        output_tokens: switchedTokensOutput,
      });
      const remainingRate = await computeCost({
        provider,
        model,
        input_tokens: remainingInput,
        output_tokens: remainingOutput,
      });
      recommendedCost +=
        (switchedRate.rate_found ? switchedRate.cost_usd : 0) + (remainingRate.rate_found ? remainingRate.cost_usd : 0);
    } else {
      recommendedCost += Number(row.total_cost) || 0;
    }

    // Scenario 3: every request had used this provider's cheapest tier.
    const cheapest = cheapestModel(provider) || model;
    const cheapRate = await computeCost({
      provider,
      model: cheapest,
      input_tokens: row.input_tokens,
      output_tokens: row.output_tokens,
    });
    aggressiveCost += cheapRate.rate_found ? cheapRate.cost_usd : Number(row.total_cost) || 0;
  }

  const qualityFor = async (pairs) => {
    if (!pairs.length) return null;
    const placeholders = pairs.map(() => "(provider = ? AND primary_model = ? AND candidate_model = ?)").join(" OR ");
    const params = pairs.flatMap((p) => [p.provider, p.primary, p.candidate]);
    const row = await db.get(
      `SELECT AVG(judge_score) AS avg_judge FROM evaluation_results WHERE (${placeholders}) AND judge_score IS NOT NULL`,
      params
    );
    return row?.avg_judge != null ? Math.round(row.avg_judge * 100) / 100 : null;
  };

  const recommendedPairs = Object.values(policyByKey).map((p) => ({
    provider: p.provider,
    primary: p.from_model,
    candidate: p.to_model,
  }));
  const aggressivePairs = spend
    .map((r) => ({ provider: r.provider, primary: r.model, candidate: cheapestModel(r.provider) }))
    .filter((p) => p.candidate && p.candidate !== p.primary);

  return {
    window_days: days,
    scenarios: [
      {
        name: "all_premium",
        label: "All requests use the premium tier",
        monthly_cost_usd: round2(allPremiumCost),
        quality_score: null, // baseline - nothing to evaluate against itself
        savings_vs_baseline_usd: round2(baselineCost - allPremiumCost),
      },
      {
        name: "current_actual",
        label: "Current actual traffic (what really happened)",
        monthly_cost_usd: round2(baselineCost),
        quality_score: null,
        savings_vs_baseline_usd: 0,
      },
      {
        name: "recommended_routing",
        label: "Approved recommendations at their current rollout %",
        monthly_cost_usd: round2(recommendedCost),
        quality_score: await qualityFor(recommendedPairs),
        savings_vs_baseline_usd: round2(baselineCost - recommendedCost),
      },
      {
        name: "aggressive_routing",
        label: "Every request uses the cheapest feasible tier",
        monthly_cost_usd: round2(aggressiveCost),
        quality_score: await qualityFor(aggressivePairs),
        savings_vs_baseline_usd: round2(baselineCost - aggressiveCost),
      },
    ],
  };
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

module.exports = { recordSaving, getSavingsSummary, getTieredEconomicsReport };
