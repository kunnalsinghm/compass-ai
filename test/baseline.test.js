const test = require("./helpers/tenantTest");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

process.env.COMPASS_DB_PATH = path.join(__dirname, `.tmp-baseline-${process.pid}.db`);
const { setupGuardFixture } = require("./helpers/guardFixture");
const fixture = setupGuardFixture(`baseline-${process.pid}`);

const DAY = 86400000;
const now = new Date("2026-06-30T12:00:00Z");
const at = (daysAgo) => new Date(now.getTime() - daysAgo * DAY).toISOString();
const events = (n, daysAgo, cost, tokens = 100) =>
  Array.from({ length: n }, (_, i) => ({ event_time: at(daysAgo + i * 0.01), provider: "openai", model: "gpt-4o", cost_usd: cost, input_tokens: tokens, output_tokens: tokens }));

const db = require("../server/storage");
const savings = require("../server/savings");

test.after(() => {
  fixture.cleanup();
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(process.env.COMPASS_DB_PATH + suffix); } catch { /* ignore */ }
  }
});

async function ledger(net, createdIso) {
  await db.run(
    `INSERT INTO savings_ledger (tenant_key, kind, gross_savings_usd, overhead_usd, net_savings_usd, created_at) VALUES ('', 'routing_switch', ?, 0, ?, ?)`,
    [net, net, createdIso.slice(0, 19).replace("T", " ")]
  );
}

test("no ledger history means there is nothing to compare", async () => {
  const r = await savings.getBaselineVerification({ now });
  assert.equal(r.status, "no-compass-history");
});

test("a thin baseline is reported as insufficient, not as a result", async () => {
  fixture.seed({ usage_events: events(5, 50, 0.1) });
  await ledger(1, at(20));
  const r = await savings.getBaselineVerification({ now, days: 15 });
  assert.equal(r.status, "insufficient-baseline");
  assert.equal(r.implied_savings_usd, null);
});

test("observed drop in cost per request that matches the ledger is corroborated", async () => {
  // Baseline: 100 requests at $0.10 (days 50-49). After Compass (started day 20): 100 requests at $0.06.
  fixture.seed({ usage_events: [...events(100, 49, 0.1), ...events(100, 10, 0.06)] });
  await db.run(`DELETE FROM savings_ledger`);
  await ledger(0, at(20)); // marks the start
  await ledger(4, at(5)); // ledger claims $4; observed is 100 * (0.10 - 0.06) = $4
  const r = await savings.getBaselineVerification({ now, days: 30, baselineDays: 30 });
  assert.equal(r.status, "corroborated");
  assert.ok(Math.abs(r.implied_savings_usd - 4) < 0.5, `implied ${r.implied_savings_usd}`);
  assert.ok(r.cost_per_request_change_pct < 0);
});

test("a ledger that claims far more than Guard's data shows is flagged", async () => {
  await ledger(40, at(4)); // now claims ~44 vs ~4 observed
  const r = await savings.getBaselineVerification({ now, days: 30, baselineDays: 30 });
  assert.equal(r.status, "ledger-exceeds-observed");
});
