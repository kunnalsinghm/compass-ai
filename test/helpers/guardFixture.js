// test/helpers/guardFixture.js - builds a throwaway Guard-shaped SQLite
// database so tests can exercise Compass's guardDb.js read path without
// a real Guard deployment running. Column shapes are copied from Guard's
// own server/storage/schema.sqlite.js (usage_events, api_keys,
// pricing_overrides, model_allowlist, budgets) - if Guard's schema ever
// changes, update this fixture to match, the same way schema.postgres.js
// is kept alongside schema.sqlite.js in Compass's own storage layer.
//
// IMPORTANT: call setupGuardFixture() BEFORE requiring any Compass module
// that transitively requires ../server/guardDb - guardDb.js checks the
// file exists at require time.

const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

function setupGuardFixture(testName) {
  const dbPath = path.join(__dirname, `.tmp-guard-${testName}-${process.pid}.db`);
  for (const f of fs.readdirSync(__dirname)) {
    if (f.startsWith(`.tmp-guard-${testName}-`)) {
      try {
        fs.unlinkSync(path.join(__dirname, f));
      } catch {
        /* ignore */
      }
    }
  }

  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_time TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      team TEXT,
      environment TEXT,
      customer_id TEXT,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cost_usd REAL NOT NULL
    );
    CREATE TABLE api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key_id TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'developer',
      team TEXT,
      status TEXT NOT NULL DEFAULT 'active'
    );
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE
    );
    CREATE TABLE pricing_overrides (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      input_per_1k REAL NOT NULL,
      output_per_1k REAL NOT NULL
    );
    CREATE TABLE model_allowlist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope_type TEXT NOT NULL,
      scope_value TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL
    );
    CREATE TABLE region_allowlist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope_type TEXT NOT NULL,
      scope_value TEXT NOT NULL,
      region TEXT NOT NULL
    );
    CREATE TABLE budgets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope_type TEXT NOT NULL,
      scope_value TEXT NOT NULL,
      monthly_limit_usd REAL NOT NULL
    );
  `);
  db.close();

  process.env.GUARD_DB_PATH = dbPath;
  process.env.GUARD_DB_DRIVER = "sqlite";

  return {
    dbPath,
    seed(rows) {
      const seedDb = new DatabaseSync(dbPath);
      for (const row of rows.usage_events || []) {
        seedDb
          .prepare(
            `INSERT INTO usage_events (event_time, provider, model, team, environment, customer_id, input_tokens, output_tokens, cost_usd)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            row.event_time || new Date().toISOString(),
            row.provider,
            row.model,
            row.team || null,
            row.environment || null,
            row.customer_id || null,
            row.input_tokens || 0,
            row.output_tokens || 0,
            row.cost_usd
          );
      }
      for (const row of rows.api_keys || []) {
        seedDb
          .prepare(`INSERT INTO api_keys (key_id, label, role, team, status) VALUES (?, ?, ?, ?, ?)`)
          .run(row.key_id, row.label || row.key_id, row.role || "developer", row.team || null, row.status || "active");
      }
      for (const row of rows.pricing_overrides || []) {
        seedDb
          .prepare(`INSERT INTO pricing_overrides (provider, model, input_per_1k, output_per_1k) VALUES (?, ?, ?, ?)`)
          .run(row.provider, row.model, row.input_per_1k, row.output_per_1k);
      }
      for (const row of rows.model_allowlist || []) {
        seedDb
          .prepare(`INSERT INTO model_allowlist (scope_type, scope_value, provider, model) VALUES (?, ?, ?, ?)`)
          .run(row.scope_type, row.scope_value, row.provider, row.model);
      }
      for (const row of rows.region_allowlist || []) {
        seedDb.prepare(`INSERT INTO region_allowlist (scope_type, scope_value, region) VALUES (?, ?, ?)`).run(row.scope_type, row.scope_value, row.region);
      }
      for (const row of rows.budgets || []) {
        seedDb.prepare(`INSERT INTO budgets (scope_type, scope_value, monthly_limit_usd) VALUES (?, ?, ?)`).run(row.scope_type, row.scope_value, row.monthly_limit_usd);
      }
      seedDb.close();
    },
    cleanup() {
      try {
        fs.unlinkSync(dbPath);
      } catch {
        /* ignore */
      }
      try {
        fs.unlinkSync(dbPath + "-wal");
      } catch {
        /* ignore */
      }
      try {
        fs.unlinkSync(dbPath + "-shm");
      } catch {
        /* ignore */
      }
    },
  };
}

module.exports = { setupGuardFixture };
