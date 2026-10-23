const test = require("./helpers/tenantTest");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

for (const f of fs.readdirSync(__dirname)) {
  if (/^\.tmp-router-\d+\.db/.test(f)) {
    try {
      fs.unlinkSync(path.join(__dirname, f));
    } catch {
      /* ignore */
    }
  }
}
process.env.COMPASS_DB_PATH = path.join(__dirname, `.tmp-router-${process.pid}.db`);

const { setupGuardFixture } = require("./helpers/guardFixture");
const fixture = setupGuardFixture(`router-${process.pid}`);
fixture.seed({
  model_allowlist: [{ scope_type: "team", scope_value: "restricted-team", provider: "openai", model: "gpt-4o" }],
});

const router = require("../server/router");
const db = require("../server/storage");

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

test("classify: short prompt with no tools is 'easy'", () => {
  const { classification } = router.classify({ messages: [{ role: "user", content: "hi" }] });
  assert.equal(classification, "easy");
});

test("classify: safety keyword always wins regardless of length", () => {
  const { classification } = router.classify({ messages: [{ role: "user", content: "What's the right suicide prevention hotline number?" }] });
  assert.equal(classification, "safety-sensitive");
});

test("classify: heavy tool use is 'tool-heavy'", () => {
  const tools = Array.from({ length: 5 }, (_, i) => ({ name: `tool_${i}` }));
  const { classification } = router.classify({ messages: [{ role: "user", content: "do stuff" }], tools });
  assert.equal(classification, "tool-heavy");
});

test("dialAllowsDowngrade: safety-sensitive never downgrades, even at dial 10", () => {
  assert.equal(router.dialAllowsDowngrade(10, "safety-sensitive"), false);
});

test("dialAllowsDowngrade: dial 1 never downgrades anything", () => {
  assert.equal(router.dialAllowsDowngrade(1, "easy"), false);
});

test("dialAllowsDowngrade: dial 8 downgrades easy/medium traffic", () => {
  assert.equal(router.dialAllowsDowngrade(8, "easy"), true);
  assert.equal(router.dialAllowsDowngrade(8, "medium"), true);
});

test("decideRoute: aggressive dial downgrades an easy openai request to the cheapest tier", async () => {
  const result = await router.decideRoute({
    provider: "openai",
    requestedModel: "gpt-4o",
    body: { messages: [{ role: "user", content: "hi" }] },
    team: "growth",
    customerId: null,
    apiKeyId: null,
    costQualityDial: 9,
  });
  assert.equal(result.effectiveModel, "gpt-4o-mini");
  assert.ok(result.reasons.some((r) => r.includes("dial")));
});

test("decideRoute: conservative dial keeps the requested model", async () => {
  const result = await router.decideRoute({
    provider: "openai",
    requestedModel: "gpt-4o",
    body: { messages: [{ role: "user", content: "hi" }] },
    team: "growth",
    costQualityDial: 1,
  });
  assert.equal(result.effectiveModel, "gpt-4o");
});

test("decideRoute: model allowlist blocks a downgrade outside the allowed set", async () => {
  const result = await router.decideRoute({
    provider: "openai",
    requestedModel: "gpt-4o",
    body: { messages: [{ role: "user", content: "hi" }] },
    team: "restricted-team", // allowlisted for gpt-4o only, per fixture seed above
    costQualityDial: 9,
  });
  assert.equal(result.effectiveModel, "gpt-4o");
  assert.ok(result.reasons.some((r) => r.includes("allowlist")));
});

test("decideRoute: an approved 100% policy always wins over the dial", async () => {
  await db.run(
    `INSERT INTO routing_policies (tenant_key, scope_type, scope_value, provider, from_model, to_model, rollout_pct, status, recommendation_id)
     VALUES ('', 'global', '', 'openai', 'gpt-4o', 'gpt-4o-mini', 100, 'full', 1)`
  );
  const result = await router.decideRoute({
    provider: "openai",
    requestedModel: "gpt-4o",
    body: { messages: [{ role: "user", content: "hi" }] },
    team: "growth",
    costQualityDial: 0, // even the most conservative dial setting
  });
  assert.equal(result.effectiveModel, "gpt-4o-mini");
  assert.equal(result.classification, "policy-routed");
});
