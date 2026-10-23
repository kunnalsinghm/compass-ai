// router.js - Compass's routing engine, "interpretable classifier mode"
// from the blueprint (section 3.4): every decision is a short list of
// plain-English reasons, never an opaque model score. Learned-router mode
// is explicitly out of scope for this build (blueprint 3.11 defers it
// until there's enough customer-specific evaluation data) - see
// evaluateRecommendation in recommend.js for where that data would
// eventually come from.
//
// Decision order on every request:
//   1. Is there an APPROVED routing policy for this exact (provider,
//      requested model) pair? If so, sample against its rollout_pct -
//      this is what makes "5% canary" or "50% majority rollout" real
//      instead of a status label. Below is skipped entirely: an approved
//      policy is a human decision and takes precedence over the dial.
//   2. Otherwise, classify the request (difficulty tier) and combine with
//      the caller's cost-quality dial (0-10) to optionally suggest a
//      cheaper same-provider model - but NEVER for anything classified
//      safety-sensitive or specialized, and never to a model outside
//      Guard's model_allowlist for this scope.
//   3. Budget pressure (spend already close to a Guard-defined budget for
//      this team) can force step 2's aggressive behavior even at a
//      conservative dial setting - proactive, complementary to Guard's
//      own reactive 80%-budget circuit breaker.
//
// A "fallback chain" (different PROVIDER, not just cheaper tier) is
// intentionally a separate, simpler mechanism - see resolveFallbackProvider
// - used only when the primary provider call itself fails, not as a
// cost-routing decision.

const { ladderFor } = require("./modelTiers");
const guardDb = require("./guardDb");
const guardPolicy = require("./guardPolicy");
const db = require("./storage");
const { tenantKey } = require("./tenantContext");

const SAFETY_KEYWORDS = ["medical diagnosis", "legal advice", "suicide", "self-harm", "prescription dosage"];

function estimateTokens(text) {
  return Math.ceil((text || "").length / 4);
}

function extractText(body) {
  const parts = [];
  if (typeof body?.system === "string") parts.push(body.system);
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  for (const m of messages) {
    if (typeof m?.content === "string") parts.push(m.content);
    else if (Array.isArray(m?.content)) {
      for (const b of m.content) if (typeof b?.text === "string") parts.push(b.text);
    }
  }
  return parts.join("\n");
}

// Interpretable classifier - explainable rules, not a learned model. See
// blueprint's own example decision shape (section 3.4) for the format
// this deliberately mirrors.
function classify(body) {
  const text = extractText(body);
  const tokenEstimate = estimateTokens(text);
  const hasTools = Array.isArray(body?.tools) && body.tools.length > 0;
  const wantsStructured = Boolean(body?.response_format);
  const lower = text.toLowerCase();
  const isSafetySensitive = SAFETY_KEYWORDS.some((kw) => lower.includes(kw));
  const isLongContext = tokenEstimate > 6000;

  const reasons = [`Input length: ~${tokenEstimate} tokens`];
  let tier = "easy";

  if (isSafetySensitive) {
    tier = "safety-sensitive";
    reasons.push("Matched a safety-sensitive keyword - routing decisions never downgrade this tier");
  } else if (isLongContext) {
    tier = "long-context";
    reasons.push("Input exceeds 6,000 estimated tokens");
  } else if (hasTools && body.tools.length >= 4) {
    tier = "tool-heavy";
    reasons.push(`Request defines ${body.tools.length} tools`);
  } else if (hasTools) {
    tier = "medium";
    reasons.push("Request uses tool-calling");
  } else if (wantsStructured || tokenEstimate > 1500) {
    tier = "medium";
    if (wantsStructured) reasons.push("Requires structured output");
    if (tokenEstimate > 1500) reasons.push("Input length is above the easy-tier threshold (1,500 tokens)");
  } else {
    reasons.push("No tool use, no structured-output requirement, short input");
  }

  return { classification: tier, reasons, tokenEstimate };
}

// Dial semantics from the blueprint (section 3.4): only 6+ ever forces a
// downgrade against a request's own classification; 0-4 only downgrades
// the easiest, lowest-risk traffic; 5 is the balanced default.
function dialAllowsDowngrade(dial, classification) {
  if (["safety-sensitive", "specialized"].includes(classification)) return false;
  if (dial <= 2) return false;
  if (dial <= 4) return classification === "easy";
  if (dial === 5) return ["easy", "medium"].includes(classification);
  if (dial <= 7) return !["long-context", "tool-heavy"].includes(classification);
  return true; // 8-10: aggressive, downgrade anything not safety/specialized
}

async function findApprovedPolicy(provider, model) {
  return db.get(
    `SELECT * FROM routing_policies WHERE tenant_key = ? AND provider = ? AND from_model = ? AND status NOT IN ('rejected','rolled_back') AND rollout_pct > 0`,
    [tenantKey(), provider, model]
  );
}

// Same rule Guard enforces (see guardPolicy.js): the key's own list wins if it
// has one, else the team's, else unrestricted. Checking a different rule here
// than Guard applies would make Compass refuse routes Guard would allow (or
// propose ones Guard would then block).
async function isModelAllowed(provider, model, team, apiKeyId) {
  return (await guardPolicy.checkModelAllowed({ keyId: apiKeyId, team, provider, model })).allowed;
}

async function checkBudgetPressure(team) {
  if (!team) return false;
  try {
    // Guard's budgets table (scope_type, scope_value, monthly_limit_usd) has
    // no period column - every budget row is a monthly limit. A scope can in
    // principle have more than one row; take the smallest limit so pressure
    // is judged against the tightest constraint that applies.
    const budgets = await guardDb.getBudgetsForScope("team", team);
    if (!budgets.length) return false;
    const tightestLimit = Math.min(...budgets.map((b) => Number(b.monthly_limit_usd)).filter((n) => Number.isFinite(n) && n > 0));
    if (!Number.isFinite(tightestLimit) || tightestLimit <= 0) return false;

    // Calendar month, because that is what Guard's budget limit is measured against.
    const teamSpend = await guardDb.getTeamMonthSpend(team);
    return teamSpend / tightestLimit >= 0.8;
  } catch {
    return false; // budgets table shape can vary - never let this block a request
  }
}

async function logDecision({ provider, requestedModel, effectiveModel, classification, dial, policyId, reasons, team, customerId }) {
  await db.run(
    `INSERT INTO routing_decisions_log
       (tenant_key, provider, requested_model, effective_model, classification, cost_quality_dial, policy_id, reasons_json, team, customer_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [tenantKey(), provider, requestedModel, effectiveModel, classification, dial ?? null, policyId || null, JSON.stringify(reasons), team || null, customerId || null]
  );
}

// The single entry point the proxy route calls. Returns the effective
// model to actually request, plus a full explanation of why.
async function decideRoute({ provider, requestedModel, body, team, customerId, apiKeyId, costQualityDial }) {
  const dial = Number.isFinite(costQualityDial) ? Math.min(10, Math.max(0, costQualityDial)) : 5;

  // Step 1: an approved, human-reviewed policy always wins over the dial.
  const policy = await findApprovedPolicy(provider, requestedModel);
  if (policy) {
    const roll = Math.random() * 100;
    if (roll < policy.rollout_pct) {
      const allowed = await isModelAllowed(provider, policy.to_model, team, apiKeyId);
      if (allowed) {
        const reasons = [
          `Approved recommendation #${policy.recommendation_id} is live at ${policy.rollout_pct}% rollout (status: ${policy.status})`,
          `This request was sampled into the ${policy.rollout_pct}% (roll=${roll.toFixed(1)})`,
        ];
        await logDecision({
          provider,
          requestedModel,
          effectiveModel: policy.to_model,
          classification: "policy-routed",
          dial,
          policyId: policy.id,
          reasons,
          team,
          customerId,
        });
        return { effectiveModel: policy.to_model, classification: "policy-routed", reasons, dial, policyId: policy.id };
      }
    }
    // Not sampled into the rollout, or target model isn't allowed for this
    // scope - fall through to classifier-based routing below using the
    // ORIGINAL requested model as the baseline.
  }

  // Step 2 + 3: interpretable classifier + dial, with budget pressure able
  // to push the effective dial up (never down - budget pressure never
  // makes Compass MORE conservative than the caller asked).
  const { classification, reasons, tokenEstimate } = classify(body);
  const underBudgetPressure = await checkBudgetPressure(team);
  const effectiveDial = underBudgetPressure ? Math.max(dial, 8) : dial;
  if (underBudgetPressure) reasons.push("Team is at or above 80% of its Guard-defined monthly budget - dial raised to 8");

  let effectiveModel = requestedModel;
  if (dialAllowsDowngrade(effectiveDial, classification)) {
    // Ladders are per model family (modelTiers.js). A model on no ladder - a
    // new release, a fine-tune - is left alone: unknown must never be read as
    // "downgrade to the cheapest rung".
    const found = ladderFor(provider, requestedModel);
    if (!found) {
      reasons.push(`'${requestedModel}' is not on a known tier ladder - Compass only re-routes models it can place, keeping it as requested`);
    }
    const ladder = found?.ladder || [];
    // Downgrade by one tier at dial 3-7, straight to cheapest at 8-10.
    const targetEntry = !found || found.index === 0 ? null : effectiveDial >= 8 ? ladder[0] : ladder[found.index - 1];
    if (targetEntry) {
      const allowed = await isModelAllowed(provider, targetEntry.model, team, apiKeyId);
      if (allowed) {
        effectiveModel = targetEntry.model;
        reasons.push(`Cost-quality dial ${effectiveDial}/10 permits downgrading '${classification}' traffic to the ${targetEntry.tier} tier`);
      } else {
        reasons.push(`Dial would downgrade to ${targetEntry.model}, but that model isn't in this scope's Guard allowlist - keeping ${requestedModel}`);
      }
    }
  } else {
    reasons.push(`Cost-quality dial ${effectiveDial}/10 does not permit downgrading '${classification}' traffic`);
  }

  await logDecision({ provider, requestedModel, effectiveModel, classification, dial: effectiveDial, policyId: null, reasons, team, customerId });
  return { effectiveModel, classification, reasons, dial: effectiveDial, policyId: null, tokenEstimate };
}

// Fallback chain: a DIFFERENT provider to retry against if the primary
// provider call itself errors/times out (outage, not a cost decision).
// Static config, not learned - COMPASS_PROVIDER_FALLBACK="openai:anthropic,anthropic:openai"
const FALLBACK_CHAIN = Object.fromEntries(
  (process.env.COMPASS_PROVIDER_FALLBACK || "")
    .split(",")
    .map((pair) => pair.split(":").map((s) => s.trim()))
    .filter((pair) => pair.length === 2 && pair[0] && pair[1])
);

function resolveFallbackProvider(provider) {
  return FALLBACK_CHAIN[provider] || null;
}

async function getRecentDecisions({ limit = 50 } = {}) {
  return db.all(`SELECT * FROM routing_decisions_log WHERE tenant_key = ? ORDER BY id DESC LIMIT ?`, [tenantKey(), limit]);
}

module.exports = {
  classify,
  decideRoute,
  resolveFallbackProvider,
  getRecentDecisions,
  dialAllowsDowngrade,
  estimateTokens,
};
