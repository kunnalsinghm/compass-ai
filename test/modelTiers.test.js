const test = require("node:test");
const assert = require("node:assert/strict");
const { CHEAPER_ALTERNATIVES, TIER_LADDER, tierForModel, cheapestModel, modelForTier } = require("../server/modelTiers");

test("CHEAPER_ALTERNATIVES only proposes same-provider switches", () => {
  for (const [key, alt] of Object.entries(CHEAPER_ALTERNATIVES)) {
    const [provider] = key.split("/");
    assert.equal(alt.provider, provider, `${key} should not cross providers`);
  }
});

test("tierForModel finds the right tier", () => {
  assert.equal(tierForModel("openai", "gpt-4o"), "premium");
  assert.equal(tierForModel("openai", "gpt-4o-mini"), "economical");
  assert.equal(tierForModel("anthropic", "claude-sonnet"), "balanced");
  assert.equal(tierForModel("anthropic", "unknown-model"), null);
});

test("cheapestModel returns the first (cheapest) rung of the ladder", () => {
  assert.equal(cheapestModel("openai"), "gpt-4o-mini");
  assert.equal(cheapestModel("anthropic"), "claude-haiku");
});

test("modelForTier resolves a tier name back to a model", () => {
  assert.equal(modelForTier("anthropic", "premium"), "claude-opus");
  assert.equal(modelForTier("openai", "economical"), "gpt-4o-mini");
});

test("TIER_LADDER is ordered cheapest-first for every provider", () => {
  // Sanity check on the ladder shape itself, since router.js relies on
  // index 0 being the cheapest rung.
  for (const [provider, ladder] of Object.entries(TIER_LADDER)) {
    assert.ok(ladder.length >= 1, `${provider} ladder should not be empty`);
    assert.equal(ladder[0].tier, "economical", `${provider}'s first rung should be economical`);
  }
});
