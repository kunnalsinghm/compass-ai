const test = require("./helpers/tenantTest");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

for (const f of fs.readdirSync(__dirname)) {
  if (/^\.tmp-cache-\d+\.db/.test(f)) {
    try {
      fs.unlinkSync(path.join(__dirname, f));
    } catch {
      /* ignore */
    }
  }
}
process.env.COMPASS_DB_PATH = path.join(__dirname, `.tmp-cache-${process.pid}.db`);

const { setupGuardFixture } = require("./helpers/guardFixture");
const fixture = setupGuardFixture(`cache-${process.pid}`);

const cache = require("../server/cache");
const { getSavingsSummary } = require("../server/savings");

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

test("makeCacheKey is stable for identical requests and different for different teams", () => {
  const body = { model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] };
  const keyA = cache.makeCacheKey({ provider: "openai", model: "gpt-4o-mini", body, team: "growth", customerId: null });
  const keyB = cache.makeCacheKey({ provider: "openai", model: "gpt-4o-mini", body, team: "growth", customerId: null });
  const keyC = cache.makeCacheKey({ provider: "openai", model: "gpt-4o-mini", body, team: "other-team", customerId: null });
  assert.equal(keyA, keyB, "identical requests should hash identically");
  assert.notEqual(keyA, keyC, "different teams must never share a cache key (tenant isolation)");
});

test("miss on an empty cache", async () => {
  const key = cache.makeCacheKey({ provider: "openai", model: "gpt-4o-mini", body: { x: 1 }, team: null, customerId: null });
  const result = await cache.getCached(key);
  assert.equal(result, null);
});

test("set then get returns the cached response and records a hit + savings", async () => {
  const body = { model: "gpt-4o-mini", messages: [{ role: "user", content: "what is 2+2" }] };
  const key = cache.makeCacheKey({ provider: "openai", model: "gpt-4o-mini", body, team: "growth", customerId: null });

  await cache.setCached({
    cacheKey: key,
    provider: "openai",
    model: "gpt-4o-mini",
    team: "growth",
    customerId: null,
    responseJson: { choices: [{ message: { content: "4" } }] },
    input_tokens: 10,
    output_tokens: 2,
    costUsd: 0.002,
    ttlSeconds: 60,
  });

  const hit = await cache.getCached(key);
  assert.ok(hit);
  assert.equal(hit.responseJson.choices[0].message.content, "4");

  const stats = await cache.getCacheStats();
  assert.equal(stats.total_hits, 1);
  assert.ok(stats.net_savings_usd > 0);

  const summary = await getSavingsSummary({ days: 30 });
  assert.ok(summary.by_kind.some((k) => k.kind === "exact_cache_hit" && k.events === 1));
});

test("an expired entry is treated as a miss and is removed", async () => {
  const body = { model: "gpt-4o-mini", messages: [{ role: "user", content: "expiring soon" }] };
  const key = cache.makeCacheKey({ provider: "openai", model: "gpt-4o-mini", body, team: null, customerId: null });

  await cache.setCached({
    cacheKey: key,
    provider: "openai",
    model: "gpt-4o-mini",
    responseJson: { choices: [{ message: { content: "soon to expire" } }] },
    input_tokens: 5,
    output_tokens: 1,
    costUsd: 0.001,
    ttlSeconds: -1, // already expired
  });

  const result = await cache.getCached(key);
  assert.equal(result, null);
});

test("clearCache empties the store", async () => {
  const body = { model: "gpt-4o-mini", messages: [{ role: "user", content: "to be cleared" }] };
  const key = cache.makeCacheKey({ provider: "openai", model: "gpt-4o-mini", body, team: null, customerId: null });
  await cache.setCached({ cacheKey: key, provider: "openai", model: "gpt-4o-mini", responseJson: { ok: true }, ttlSeconds: 60 });
  await cache.clearCache();
  const stats = await cache.getCacheStats();
  assert.equal(stats.current_size, 0);
});
