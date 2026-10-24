// savings.js - the savings ledger (every dollar Compass claims credit
// for, itemized) and the tiered economics report (the blueprint's
// three-scenario comparison: all-premium vs. recommended routing vs.
// aggressive routing). Never claims a theoretical saving as realized -
// see recordSaving's net_savings_usd = gross - overhead formula.

const db = require("./storage");
const guardDb = require("./guardDb");
const { computeCost } = require("./pricing");
const { sinceDaysAgo } = require("./storage/dialectSql");
const { cheapestModel, premiumModel } = require("./modelTiers");
const { tenantKey } = require("./tenantContext");

async function recordSaving({ kind, provider, model, team, customerId, grossSavingsUsd, overheadUsd = 0, referenceId }) {
  const gross = Number(grossSavingsUsd) || 0;
  const overhead = Number(overheadUsd) || 0;
  const net = Math.round((gross - overhead) * 1e6) / 1e6;
  await db.run(
    `INSERT INTO savings_ledger (tenant_key, kind, provider, model, team, customer_id, gross_savings_usd, overhead_usd, net_savings_usd, reference_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [tenantKey(), kind, provider || null, model || null, team || null, customerId || null, gross, overhead, net, referenceId || null]
  );
}

async function getSavingsSummary({ days = 30 } = {}) {
  const since = sinceDaysAgo(days);
  const byKind = await db.all(
    `SELECT kind, COUNT(*) AS events, COALESCE(SUM(gross_savings_usd),0) AS gross, COALESCE(SUM(net_savings_usd),0) AS net
     FROM savings_ledger WHERE created_at >= ${since} AND tenant_key = ? GROUP BY kind`,
    [tenantKey()]
  );
  const total = await db.get(
    `SELECT COALESCE(SUM(net_savings_usd),0) AS net_savings_usd, COUNT(*) AS events
     FROM savings_ledger WHERE created_at >= ${since} AND tenant_key = ?`,
    [tenantKey()]
  );
  return {
    window_days: days,
    total_net_savings_usd: round4(total?.net_savings_usd),
    total_events: Number(total?.events || 0),
    by_kind: byKind.map((r) => ({
      kind: r.kind,
      events: Number(r.events),
      gross_savings_usd: round4(r.gross),
      net_savings_usd: round4(r.net),
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
    `SELECT * FROM routing_policies WHERE tenant_key = ? AND status NOT IN ('rejected','rolled_back')`,
    [tenantKey()]
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
    // Family-aware: the premium rung of THIS model's own family. A model on no
    // ladder is its own premium/cheapest (we don't guess an alternative).
    const premium = premiumModel(provider, model) || model;
    const premiumRate = await computeCost({
      provider,
      model: premium,
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
    const cheapest = cheapestModel(provider, model) || model;
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
      `SELECT AVG(judge_score) AS avg_judge FROM evaluation_results WHERE tenant_key = ? AND (${placeholders}) AND judge_score IS NOT NULL`,
      [tenantKey(), ...params]
    );
    return row?.avg_judge != null ? Math.round(row.avg_judge * 100) / 100 : null;
  };

  const recommendedPairs = Object.values(policyByKey).map((p) => ({
    provider: p.provider,
    primary: p.from_model,
    candidate: p.to_model,
  }));
  const aggressivePairs = spend
    .map((r) => ({ provider: r.provider, primary: r.model, candidate: cheapestModel(r.provider, r.model) }))
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

function round4(n) {
  return Math.round((Number(n) || 0) * 10000) / 10000;
}

// Evaluation spend (shadow tests, judge calls) is the price of verifying a
// saving, so it is booked as overhead with zero gross savings. That makes
// net = gross - overhead (blueprint 3.12) true for the whole ledger rather
// than only for cache hits: a customer is never billed on savings that the
// testing itself ate.
async function recordOverhead({ kind = "shadow_test_overhead", provider, model, team, customerId, overheadUsd, referenceId }) {
  const overhead = Number(overheadUsd) || 0;
  if (overhead <= 0) return;
  await recordSaving({ kind, provider, model, team, customerId, grossSavingsUsd: 0, overheadUsd: overhead, referenceId });
}

const DEFAULT_SHARE_PCT = Number(process.env.COMPASS_SAVINGS_SHARE_PCT) || 15;

// What Compass may invoice for (blueprint 3.12): verified = realized
// savings in the ledger, net of optimization overhead - never the
// theoretical estimates on recommendations, which are reported separately
// as `unrealized_estimate_usd` precisely so they cannot be mistaken for it.
// Negative net (overhead exceeded savings) bills as zero, not as a credit.
async function getVerifiedSavings({ days = 30, sharePct = DEFAULT_SHARE_PCT } = {}) {
  const pct = Math.min(100, Math.max(0, Number(sharePct)));
  const since = sinceDaysAgo(days);
  const totals = await db.get(
    `SELECT COALESCE(SUM(gross_savings_usd),0) AS gross, COALESCE(SUM(overhead_usd),0) AS overhead,
            COALESCE(SUM(net_savings_usd),0) AS net, COUNT(*) AS entries
     FROM savings_ledger WHERE created_at >= ${since} AND tenant_key = ?`,
    [tenantKey()]
  );
  const byKind = await db.all(
    `SELECT kind, COUNT(*) AS entries, COALESCE(SUM(gross_savings_usd),0) AS gross,
            COALESCE(SUM(overhead_usd),0) AS overhead, COALESCE(SUM(net_savings_usd),0) AS net
     FROM savings_ledger WHERE created_at >= ${since} AND tenant_key = ? GROUP BY kind ORDER BY net DESC`,
    [tenantKey()]
  );
  const pending = await db.get(
    `SELECT COALESCE(SUM(estimated_savings_usd),0) AS est FROM recommendations WHERE tenant_key = ? AND status IN ('pending','approved') AND estimated_savings_usd > 0`,
    [tenantKey()]
  );
  const net = Number(totals?.net || 0);
  const billable = Math.max(0, net);
  return {
    window_days: days,
    verified_net_savings_usd: round4(net),
    gross_savings_usd: round4(totals?.gross),
    overhead_usd: round4(totals?.overhead),
    ledger_entries: Number(totals?.entries || 0),
    share_pct: pct,
    fee_usd: round4((billable * pct) / 100),
    unrealized_estimate_usd: round2(pending?.est),
    by_kind: byKind.map((r) => ({
      kind: r.kind,
      entries: Number(r.entries),
      gross_savings_usd: round4(r.gross),
      overhead_usd: round4(r.overhead),
      net_savings_usd: round4(r.net),
    })),
    notes: [
      "Verified = realized ledger savings minus optimization overhead. Recommendation estimates are not included.",
      "Routing savings compare the cost at the model actually used with what the same token counts would have cost at the requested model.",
    ],
  };
}

// ---------------------------------------------------------------------
// Baseline verification: does Guard's OWN spend data show the saving the
// ledger claims? The ledger is Compass's bookkeeping of what it did; this
// compares cost per request in a window before Compass started against the
// recent window, using only Guard's usage_events (production traffic, shadow
// tests excluded), and reports how closely the two agree.
//
// It is a corroboration, never a proof: prices, model mix and prompt size all
// move for reasons that have nothing to do with Compass, so the result carries
// an explicit status and the reasons it may be unreliable. Billing stays on the
// ledger (getVerifiedSavings); this endpoint is the audit of that number.
// ---------------------------------------------------------------------
const MIN_BASELINE_REQUESTS = Number(process.env.COMPASS_MIN_BASELINE_REQUESTS) || 50;
const MIX_DRIFT_LIMIT = 0.4; // tokens-per-request moved by more than 40%
const AGREEMENT_TOLERANCE = 0.3; // implied vs ledger within +/-30%

function windowMetrics(w) {
  const tokens = w.input_tokens + w.output_tokens;
  return {
    cost_usd: round4(w.cost),
    requests: w.requests,
    billed_requests: w.billed_requests,
    tokens,
    cost_per_request_usd: w.requests ? w.cost / w.requests : null,
    tokens_per_billed_request: w.billed_requests ? tokens / w.billed_requests : null,
  };
}

async function getBaselineVerification({ days = 30, baselineDays = 30, compassStart, now = new Date() } = {}) {
  const DAY = 86400000;
  const first = await db.get(`SELECT MIN(created_at) AS first_at FROM savings_ledger WHERE tenant_key = ?`, [tenantKey()]);
  const startRaw = compassStart || first?.first_at;
  if (!startRaw) {
    return { status: "no-compass-history", window_days: days, baseline_days: baselineDays, caveats: ["Compass has not recorded any savings yet, so there is no 'after' period to compare."] };
  }
  const startStr = startRaw instanceof Date ? startRaw.toISOString() : String(startRaw);
  const start = new Date(startStr.endsWith("Z") || startStr.includes("T") ? startStr : startStr.replace(" ", "T") + "Z");
  const nowMs = now.getTime();
  const afterFrom = new Date(Math.max(start.getTime(), nowMs - days * DAY));
  const baseTo = start;
  const baseFrom = new Date(start.getTime() - baselineDays * DAY);

  const [before, after] = await Promise.all([
    guardDb.getSpendWindow({ from: baseFrom.toISOString(), to: baseTo.toISOString() }),
    guardDb.getSpendWindow({ from: afterFrom.toISOString(), to: new Date(nowMs).toISOString() }),
  ]);
  const b = windowMetrics(before);
  const a = windowMetrics(after);

  const ledger = await db.get(
    `SELECT COALESCE(SUM(net_savings_usd),0) AS net FROM savings_ledger WHERE tenant_key = ? AND created_at >= ?`,
    [tenantKey(), afterFrom.toISOString().slice(0, 19).replace("T", " ")]
  );
  const ledgerNet = Number(ledger?.net || 0);

  const out = {
    window_days: days,
    baseline_days: baselineDays,
    compass_started_at: start.toISOString(),
    baseline: { from: baseFrom.toISOString(), to: baseTo.toISOString(), ...b },
    current: { from: afterFrom.toISOString(), to: new Date(nowMs).toISOString(), ...a },
    ledger_net_savings_usd: round4(ledgerNet),
    implied_savings_usd: null,
    agreement_ratio: null,
    status: null,
    caveats: [],
  };

  if (b.requests < MIN_BASELINE_REQUESTS) {
    out.status = "insufficient-baseline";
    out.caveats.push(`Only ${b.requests} request(s) in the ${baselineDays} days before Compass started; need at least ${MIN_BASELINE_REQUESTS} for a meaningful baseline.`);
    return out;
  }
  if (a.requests === 0) {
    out.status = "no-recent-traffic";
    out.caveats.push("No production requests in the recent window.");
    return out;
  }

  const implied = (b.cost_per_request_usd - a.cost_per_request_usd) * a.requests;
  out.implied_savings_usd = round4(implied);
  out.cost_per_request_change_pct = b.cost_per_request_usd > 0 ? round1(((a.cost_per_request_usd - b.cost_per_request_usd) / b.cost_per_request_usd) * 100) : null;

  if (b.tokens_per_billed_request && a.tokens_per_billed_request) {
    const drift = Math.abs(a.tokens_per_billed_request - b.tokens_per_billed_request) / b.tokens_per_billed_request;
    out.request_size_drift_pct = round1(drift * 100);
    if (drift > MIX_DRIFT_LIMIT) out.caveats.push(`Average request size changed by ${round1(drift * 100)}% between the two windows, so a cost-per-request comparison may reflect a different workload rather than Compass.`);
  }
  if (a.requests < MIN_BASELINE_REQUESTS) out.caveats.push(`Only ${a.requests} request(s) in the recent window; the comparison is noisy.`);

  if (ledgerNet <= 0 && implied <= 0) {
    out.status = "no-saving-observed";
  } else if (ledgerNet > 0) {
    out.agreement_ratio = round3(implied / ledgerNet);
    const close = Math.abs(out.agreement_ratio - 1) <= AGREEMENT_TOLERANCE;
    if (out.caveats.some((c) => c.startsWith("Average request size"))) out.status = "inconclusive";
    else if (close) out.status = "corroborated";
    else if (implied < ledgerNet) out.status = "ledger-exceeds-observed";
    else out.status = "observed-exceeds-ledger";
  } else {
    out.status = "observed-without-ledger";
    out.caveats.push("Guard's spend fell but the ledger has no matching savings; the drop is not attributable to Compass.");
  }
  out.caveats.push("Corroboration only: prices, model mix and workload also change cost per request. Fees are computed from the ledger, not from this comparison.");
  return out;
}

function round1(n) { return Math.round(Number(n) * 10) / 10; }
function round3(n) { return Math.round(Number(n) * 1000) / 1000; }

module.exports = { recordSaving, recordOverhead, getSavingsSummary, getTieredEconomicsReport, getVerifiedSavings, getBaselineVerification };
