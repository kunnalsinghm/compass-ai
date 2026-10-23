// modelTiers.js - the shared notion of "cheaper same-provider alternative"
// and "difficulty tier" that router.js, recommend.js, shadowTest.js, and
// savings.js's tiered economics report all build on.
//
// Same conservative, same-provider-only philosophy as Guard's
// server/modelAlternatives.js ("behavior/quality is more likely to be
// comparable than a cross-provider switch") - and now also SAME-FAMILY-only:
// a ladder never crosses a model generation (gpt-5 -> gpt-4o-mini would be a
// capability regression nobody asked for, however cheap), so each family
// below is its own ladder, cheapest first.
//
// Model ids are matched after normalisation (lowercase, "-latest" and date
// snapshots stripped - the exact rule Guard's pricing.js uses), so a dated
// "gpt-4o-2024-08-06" is recognised as gpt-4o instead of falling off the
// ladder. A model that is on NO ladder is never re-routed: Compass cannot
// reason about a model it does not know, and "unknown" must not mean
// "downgrade to the cheapest rung".

function normalizeModelId(model) {
  return String(model || "")
    .trim()
    .toLowerCase()
    .replace(/-latest$/, "")
    .replace(/-\d{4}-\d{2}-\d{2}$/, "") // gpt-4o-2024-08-06
    .replace(/-\d{8}$/, ""); // claude-sonnet-4-5-20250929
}

// Cheapest first. Every model named here must be priced in pricing.js.
const FAMILIES = {
  openai: [
    [["economical", "gpt-4o-mini"], ["premium", "gpt-4o"]],
    [["economical", "gpt-4.1-nano"], ["balanced", "gpt-4.1-mini"], ["premium", "gpt-4.1"]],
    [["economical", "gpt-5-nano"], ["balanced", "gpt-5-mini"], ["premium", "gpt-5"]],
    [["economical", "gpt-5.4-nano"], ["balanced", "gpt-5.4-mini"], ["premium", "gpt-5.4"]],
  ],
  anthropic: [
    // Generic aliases (what Guard's baseline catalogue and its fallback table use).
    [["economical", "claude-haiku"], ["balanced", "claude-sonnet"], ["premium", "claude-opus"]],
    [["economical", "claude-haiku-4-5"], ["balanced", "claude-sonnet-4-5"], ["premium", "claude-opus-4-5"]],
    [["balanced", "claude-sonnet-5"], ["premium", "claude-opus-5"]],
  ],
  bedrock: [[["economical", "titan-text-express"]]],
};

const LADDERS = {};
for (const [provider, families] of Object.entries(FAMILIES)) {
  LADDERS[provider] = families.map((f) => f.map(([tier, model]) => ({ tier, model })));
}

// Provider-level view kept for callers that only know the provider: the first
// (legacy, widest-used) family per provider. Prefer ladderFor(provider, model).
const TIER_LADDER = Object.fromEntries(Object.entries(LADDERS).map(([p, fams]) => [p, fams[0]]));

// The cheaper same-family neighbour used for recommendations/shadow tests:
// one rung down from each model that has one.
const CHEAPER_ALTERNATIVES = {};
for (const [provider, fams] of Object.entries(LADDERS)) {
  for (const ladder of fams) {
    for (let i = 1; i < ladder.length; i++) {
      CHEAPER_ALTERNATIVES[`${provider}/${ladder[i].model}`] = { provider, model: ladder[i - 1].model };
    }
  }
}

// { ladder, index, tier } for the family a model belongs to, or null.
function ladderFor(provider, model) {
  const fams = LADDERS[String(provider || "").toLowerCase()] || [];
  const wanted = normalizeModelId(model);
  for (const ladder of fams) {
    const index = ladder.findIndex((e) => e.model === wanted);
    if (index !== -1) return { ladder, index, tier: ladder[index].tier };
  }
  return null;
}

function tierForModel(provider, model) {
  return ladderFor(provider, model)?.tier || null;
}

// With a model: the cheapest rung of THAT model's family (or null if the model
// is unknown). Without: the first family's cheapest rung (provider default).
function cheapestModel(provider, model) {
  if (model !== undefined) return ladderFor(provider, model)?.ladder[0].model || null;
  const ladder = TIER_LADDER[String(provider || "").toLowerCase()] || [];
  return ladder[0]?.model || null;
}

function premiumModel(provider, model) {
  const found = ladderFor(provider, model);
  return found ? found.ladder[found.ladder.length - 1].model : null;
}

function modelForTier(provider, tier) {
  const ladder = TIER_LADDER[String(provider || "").toLowerCase()] || [];
  return (ladder.find((e) => e.tier === tier) || ladder[0])?.model || null;
}

// Cheaper alternative for a (possibly dated) model id, or null.
function cheaperAlternative(provider, model) {
  const found = ladderFor(provider, model);
  if (!found || found.index === 0) return null;
  return { provider: String(provider).toLowerCase(), model: found.ladder[found.index - 1].model };
}

module.exports = {
  CHEAPER_ALTERNATIVES,
  TIER_LADDER,
  FAMILIES: LADDERS,
  normalizeModelId,
  ladderFor,
  tierForModel,
  cheapestModel,
  premiumModel,
  cheaperAlternative,
  modelForTier,
};
