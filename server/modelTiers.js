// modelTiers.js - the shared notion of "cheaper same-provider alternative"
// and "difficulty tier" that router.js, recommend.js, shadowTest.js, and
// savings.js's tiered economics report all build on.
//
// CHEAPER_ALTERNATIVES intentionally matches Guard's own
// server/modelAlternatives.js pairs exactly - same conservative,
// same-provider-only philosophy ("behavior/quality is more likely to be
// comparable than a cross-provider switch"), so a recommendation that
// says "switch gpt-4o -> gpt-4o-mini" means the same thing whether it
// came from Guard's rule-based heuristic or Compass's evaluated one.
const CHEAPER_ALTERNATIVES = {
  "openai/gpt-4o": { provider: "openai", model: "gpt-4o-mini" },
  "anthropic/claude-opus": { provider: "anthropic", model: "claude-sonnet" },
  "anthropic/claude-sonnet": { provider: "anthropic", model: "claude-haiku" },
};

// The full difficulty-tier ladder per provider, cheapest first, used by
// the interpretable classifier router (router.js) and the "aggressive
// routing" scenario in the tiered economics report (savings.js). Not
// every provider/tier combination needs to exist - a provider with only
// two real tiers just omits "balanced".
const TIER_LADDER = {
  openai: [
    { tier: "economical", model: "gpt-4o-mini" },
    { tier: "premium", model: "gpt-4o" },
  ],
  anthropic: [
    { tier: "economical", model: "claude-haiku" },
    { tier: "balanced", model: "claude-sonnet" },
    { tier: "premium", model: "claude-opus" },
  ],
  bedrock: [{ tier: "economical", model: "titan-text-express" }],
};

function tierForModel(provider, model) {
  const ladder = TIER_LADDER[String(provider || "").toLowerCase()] || [];
  const entry = ladder.find((e) => e.model === model);
  return entry ? entry.tier : null;
}

function cheapestModel(provider) {
  const ladder = TIER_LADDER[String(provider || "").toLowerCase()] || [];
  return ladder[0]?.model || null;
}

function modelForTier(provider, tier) {
  const ladder = TIER_LADDER[String(provider || "").toLowerCase()] || [];
  return (ladder.find((e) => e.tier === tier) || ladder[0])?.model || null;
}

module.exports = { CHEAPER_ALTERNATIVES, TIER_LADDER, tierForModel, cheapestModel, modelForTier };
