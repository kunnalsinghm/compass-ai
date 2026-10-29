const test = require("./helpers/tenantTest");
const nodeTest = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

process.env.COMPASS_DB_PATH = path.join(__dirname, `.tmp-integ-${process.pid}.db`);
const { setupGuardFixture } = require("./helpers/guardFixture");
const fixture = setupGuardFixture(`integ-${process.pid}`);
fixture.seed({
  model_allowlist: [{ scope_type: "team", scope_value: "locked", provider: "openai", model: "gpt-4o" }],
  region_allowlist: [{ scope_type: "team", scope_value: "eu-team", region: "eu" }],
});

const tenantContext = require("../server/tenantContext");
const cache = require("../server/cache");
const fallback = require("../server/fallback");
const guardPolicy = require("../server/guardPolicy");
const modelTiers = require("../server/modelTiers");
const legacy = require("../server/storage/legacyMigrate");
const { DatabaseSync } = require("node:sqlite");

nodeTest.after(() => {
  fixture.cleanup();
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(process.env.COMPASS_DB_PATH + suffix); } catch { /* ignore */ }
  }
});

nodeTest("tenant context fails closed outside a context", () => {
  assert.equal(tenantContext.hasContext(), false);
  assert.throws(() => tenantContext.tenantKey());
});

nodeTest("tenant context is scoped per run and isolated between tenants", () => {
  tenantContext.runWithTenant({ tenantId: 7 }, () => assert.equal(tenantContext.tenantKey(), "7"));
  tenantContext.runWithTenant({}, () => assert.equal(tenantContext.tenantKey(), ""));
});

nodeTest("cache entries never cross tenants, even for an identical request", async () => {
  const body = { model: "gpt-4o", messages: [{ role: "user", content: "tenant isolation probe" }] };
  const keyA = tenantContext.runWithTenant({ tenantId: 1 }, () => cache.makeCacheKey({ provider: "openai", team: "t", body }));
  const keyB = tenantContext.runWithTenant({ tenantId: 2 }, () => cache.makeCacheKey({ provider: "openai", team: "t", body }));
  assert.notEqual(keyA, keyB);
  await tenantContext.runWithTenant({ tenantId: 1 }, () =>
    cache.setCached({ cacheKey: keyA, provider: "openai", model: "gpt-4o", team: "t", responseJson: { ok: 1 }, costUsd: 0.01 })
  );
  assert.ok(await tenantContext.runWithTenant({ tenantId: 1 }, () => cache.getCached(keyA)));
  // Tenant 2 asking for tenant 1's key directly must still miss.
  assert.equal(await tenantContext.runWithTenant({ tenantId: 2 }, () => cache.getCached(keyA)), null);
});

test("guardPolicy mirrors most-specific-wins model allow-list", async () => {
  assert.equal((await guardPolicy.checkModelAllowed({ keyId: "k", team: "locked", provider: "openai", model: "gpt-4o" })).allowed, true);
  assert.equal((await guardPolicy.checkModelAllowed({ keyId: "k", team: "locked", provider: "openai", model: "gpt-4o-mini" })).allowed, false);
  assert.equal((await guardPolicy.checkModelAllowed({ keyId: "k", team: "open", provider: "openai", model: "gpt-4o-mini" })).allowed, true);
});

test("guardPolicy enforces the region allow-list and ignores undeclared regions", async () => {
  assert.equal((await guardPolicy.checkRegionAllowed({ keyId: "k", team: "eu-team", region: "us" })).allowed, false);
  assert.equal((await guardPolicy.checkRegionAllowed({ keyId: "k", team: "eu-team", region: "eu" })).allowed, true);
  assert.equal((await guardPolicy.checkRegionAllowed({ keyId: "k", team: "eu-team", region: undefined })).allowed, true);
});

nodeTest("unknown models are never downgraded", () => {
  assert.equal(modelTiers.cheaperAlternative("openai", "some-custom-finetune"), null);
});

nodeTest("fallback only triggers on provider-outage statuses", () => {
  for (const s of [500, 502, 503, 504, 529]) assert.equal(fallback.isOutage(s), true);
  for (const s of [400, 402, 403, 429]) assert.equal(fallback.isOutage(s), false);
});

nodeTest("fallback translates plain text both ways and refuses tools", () => {
  const out = fallback.translateRequest("openai", "anthropic", {
    messages: [{ role: "system", content: "be brief" }, { role: "user", content: "hi" }],
    temperature: 2,
  });
  assert.equal(out.system, "be brief");
  assert.equal(out.temperature, 1);
  assert.ok(out.max_tokens > 0);
  assert.deepEqual(out.messages, [{ role: "user", content: "hi" }]);
  assert.equal(fallback.translateRequest("openai", "anthropic", { messages: [{ role: "user", content: "x" }], tools: [{}] }), null);
  const back = fallback.translateResponse("anthropic", "openai", {
    id: "m1", model: "claude", content: [{ type: "text", text: "yo" }], stop_reason: "end_turn", usage: { input_tokens: 3, output_tokens: 2 },
  });
  assert.equal(back.choices[0].message.content, "yo");
  assert.equal(back.usage.total_tokens, 5);
  assert.equal(fallback.translateResponse("anthropic", "openai", { content: [{ type: "tool_use" }] }), null);
});

nodeTest("legacy (pre-tenant) database is migrated without losing rows or duplicating policies", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE routing_policies (id INTEGER PRIMARY KEY AUTOINCREMENT, scope_type TEXT NOT NULL, scope_value TEXT, provider TEXT NOT NULL,
      from_model TEXT NOT NULL, to_model TEXT NOT NULL, rollout_pct INTEGER, status TEXT, recommendation_id INTEGER,
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
    INSERT INTO routing_policies (scope_type, scope_value, provider, from_model, to_model, rollout_pct, status) VALUES
      ('global', NULL, 'openai', 'gpt-4o', 'gpt-4o-mini', 5, 'canary'),
      ('global', NULL, 'openai', 'gpt-4o', 'gpt-4o-mini', 25, 'staged');
    CREATE TABLE cache_entries (id INTEGER PRIMARY KEY AUTOINCREMENT, cache_key TEXT NOT NULL UNIQUE, provider TEXT NOT NULL, model TEXT NOT NULL,
      team TEXT, customer_id TEXT, response_json TEXT NOT NULL, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
      cost_per_hit_usd REAL NOT NULL DEFAULT 0, hit_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')), expires_at TEXT NOT NULL);
    INSERT INTO cache_entries (cache_key, provider, model, response_json, expires_at) VALUES ('a','openai','gpt-4o','{}','2999-01-01');
  `);
  const { SCHEMA_SQL } = require("../server/storage/schema.sqlite");
  legacy.preSqlite(db);
  db.exec(SCHEMA_SQL);
  legacy.postSqlite(db);
  const rows = db.prepare("SELECT tenant_key, scope_value, rollout_pct FROM routing_policies").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].scope_value, "");
  assert.equal(rows[0].rollout_pct, 25); // newest duplicate survives
  assert.equal(db.prepare("SELECT tenant_key FROM cache_entries").get().tenant_key, "");
  // Idempotent on a current database.
  legacy.preSqlite(db); db.exec(SCHEMA_SQL); legacy.postSqlite(db);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM routing_policies").get().n, 1);
});

test("evaluation cases are stored with PII redacted, whatever the source", async () => {
  const evaluation = require("../server/evaluation");
  const db = require("../server/storage");
  const id = await evaluation.createEvaluationCase({
    source: "feedback",
    provider: "openai",
    primaryModel: "gpt-4o",
    candidateModel: "gpt-4o-mini",
    inputJson: { messages: [{ role: "user", content: "Email jane.doe@example.com about card 4111 1111 1111 1111" }] },
    baselineResponse: "Sure, I will write to jane.doe@example.com",
    team: "t",
  });
  const row = await db.get(`SELECT input_json, baseline_response FROM evaluation_cases WHERE id = ?`, [id]);
  assert.ok(!row.input_json.includes("jane.doe"), row.input_json);
  assert.ok(!row.input_json.includes("4111"), row.input_json);
  assert.ok(!row.baseline_response.includes("jane.doe"), row.baseline_response);
  assert.match(row.input_json, /REDACTED/);
});
