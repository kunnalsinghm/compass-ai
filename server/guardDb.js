// guardDb.js - Compass's read-only window into Guard's database.
//
// THIS is the "shared platform" integration the blueprint describes in
// section 5: Compass never re-implements usage metering, pricing, or
// RBAC - it reads Guard's existing tables directly and treats Guard as
// the single source of truth for "what happened and who is allowed to
// see it." Compass writes NOTHING here, ever - every function in this
// file is a SELECT. Its own tables (cache, routing, evaluation,
// recommendations, savings) live in Compass's own database
// (server/storage), which Guard in turn never touches.
//
// Two supported deployment shapes, matching Guard's own SQLite/Postgres
// duality:
//
//   GUARD_DB_DRIVER=sqlite (default) - Guard and Compass are co-located
//   self-hosted processes sharing a data volume. Point GUARD_DB_PATH at
//   Guard's data/finops.db. SQLite's WAL mode (which Guard already
//   enables) supports concurrent readers safely alongside Guard's own
//   writer process.
//
//   GUARD_DB_DRIVER=postgres - Guard is running its hosted Postgres
//   deployment. Point GUARD_POSTGRES_URL at the same database (and
//   GUARD_POSTGRES_SCHEMA if Guard was deployed with FINOPS_POSTGRES_SCHEMA
//   set). Compass opens its own connection pool - it never shares Guard's
//   pool or process.
//
// If Guard is unreachable (wrong path, wrong URL, Guard not running yet),
// every function here throws a clear, specific error rather than
// returning empty/zeroed data that could be mistaken for "no spend yet."

const path = require("path");
const fs = require("fs");

const DRIVER = process.env.GUARD_DB_DRIVER === "postgres" ? "postgres" : "sqlite";

let impl;

if (DRIVER === "sqlite") {
  const { DatabaseSync } = require("node:sqlite");
  const GUARD_DB_PATH =
    process.env.GUARD_DB_PATH || path.join(__dirname, "..", "..", "finops-mvp", "data", "finops.db");

  if (!fs.existsSync(GUARD_DB_PATH)) {
    throw new Error(
      `guardDb: Guard's SQLite database was not found at ${GUARD_DB_PATH}. ` +
        `Set GUARD_DB_PATH to the actual path of Guard's data/finops.db, or set ` +
        `GUARD_DB_DRIVER=postgres and GUARD_POSTGRES_URL if Guard runs on Postgres.`
    );
  }

  const raw = new DatabaseSync(GUARD_DB_PATH, { readOnly: true });

  impl = {
    dialect: "sqlite",
    async get(sql, params = []) {
      return raw.prepare(sql).get(...params);
    },
    async all(sql, params = []) {
      return raw.prepare(sql).all(...params);
    },
    ready: Promise.resolve(),
  };
} else {
  const { Pool } = require("pg");
  const rawSchema = process.env.GUARD_POSTGRES_SCHEMA;
  const poolConfig = { connectionString: process.env.GUARD_POSTGRES_URL };
  if (rawSchema) {
    if (!/^[a-z_][a-z0-9_]*$/.test(rawSchema)) {
      throw new Error(`GUARD_POSTGRES_SCHEMA must be a lowercase identifier, got '${rawSchema}'`);
    }
    poolConfig.options = `-c search_path=${rawSchema},public`;
  }
  const pool = new Pool(poolConfig);

  function toPositional(sql) {
    let i = 0;
    return sql.replace(/\?/g, () => `$${++i}`);
  }

  impl = {
    dialect: "postgres",
    async get(sql, params = []) {
      const result = await pool.query(toPositional(sql), params);
      return result.rows[0];
    },
    async all(sql, params = []) {
      const result = await pool.query(toPositional(sql), params);
      return result.rows;
    },
    ready: pool.query("SELECT 1").then(() => {}),
  };
}

// ---------------------------------------------------------------------
// High-level read helpers, built on the raw get/all above. Route/engine
// code should call these rather than writing ad-hoc SQL against Guard's
// schema in five different files - one place to update if Guard's schema
// ever changes column names.
// ---------------------------------------------------------------------

const { sinceDaysAgoLiteral } = (() => {
  // Guard's own dialectSql.js isn't reachable from this package (separate
  // deployable service - see this file's header). Same date-boundary
  // logic, inlined here in the two dialects Guard itself supports.
  function sinceDaysAgoLiteral(days, dialect) {
    const safe = Math.max(0, Math.trunc(Number(days) || 0));
    return dialect === "postgres"
      ? `TO_CHAR((NOW() AT TIME ZONE 'UTC') - INTERVAL '${safe} days', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`
      : `datetime('now', '-${safe} days')`;
  }
  return { sinceDaysAgoLiteral };
})();

// Aggregate spend by provider/model over the trailing window - the core
// input to recommend.js and savings.js's tiered economics report.
async function getSpendByModel({ days = 30 } = {}) {
  const since = sinceDaysAgoLiteral(days, impl.dialect);
  return impl.all(
    `SELECT provider, model,
            SUM(cost_usd) AS total_cost,
            SUM(input_tokens) AS input_tokens,
            SUM(output_tokens) AS output_tokens,
            COUNT(*) AS event_count
     FROM usage_events
     WHERE event_time >= ${since}
     GROUP BY provider, model`
  );
}

// Same, but broken out by team too - used for team-scoped tiered
// economics and team-scoped routing policies.
async function getSpendByModelAndTeam({ days = 30 } = {}) {
  const since = sinceDaysAgoLiteral(days, impl.dialect);
  return impl.all(
    `SELECT provider, model, team,
            SUM(cost_usd) AS total_cost,
            SUM(input_tokens) AS input_tokens,
            SUM(output_tokens) AS output_tokens,
            COUNT(*) AS event_count
     FROM usage_events
     WHERE event_time >= ${since}
     GROUP BY provider, model, team`
  );
}

// Guard's pricing catalogue overrides - read live so Guard stays the
// single source of truth for pricing (Compass's own pricing.js keeps a
// baseline catalogue copy for when Guard has no override, but overrides
// always win, matching Guard's own precedence rule).
async function getPricingOverrides() {
  return impl.all(`SELECT provider, model, input_per_1k, output_per_1k FROM pricing_overrides`);
}

// RBAC: validate an X-API-Key the exact same way Guard's own auth.js
// does, by reading the same api_keys table. Compass deliberately does not
// maintain its own user/key store - one identity system for both
// products, per the blueprint's "existing trust in the vendor" framing
// for why Autopilot (and here, Compass) builds on Guard's foundation
// rather than duplicating it.
async function findApiKey(keyId) {
  return impl.get(`SELECT * FROM api_keys WHERE key_id = ?`, [keyId]);
}

async function countKeysAndUsers() {
  const [keys, users] = await Promise.all([
    impl.get(`SELECT COUNT(*) AS n FROM api_keys`),
    impl.get(`SELECT COUNT(*) AS n FROM users`).catch(() => ({ n: 0 })),
  ]);
  return { keys: Number(keys?.n || 0), users: Number(users?.n || 0) };
}

// Model allow-listing: Compass's router should never propose routing a
// request to a model the key/team isn't allowed to use - Guard would
// reject it downstream anyway, but checking here avoids a wasted round
// trip and lets the router's explanation say WHY it didn't route.
async function getModelAllowlist(scopeType, scopeValue) {
  if (!scopeValue) return [];
  return impl.all(
    `SELECT provider, model FROM model_allowlist WHERE scope_type = ? AND scope_value = ?`,
    [scopeType, scopeValue]
  );
}

// Active budgets for a scope, used by the router's cost-quality dial to
// know when a team/key is already close to a Guard-enforced budget
// (see router.js's budget-aware fallback behavior).
async function getBudgetsForScope(scopeType, scopeValue) {
  if (!scopeValue) return [];
  return impl.all(`SELECT * FROM budgets WHERE scope_type = ? AND scope_value = ?`, [scopeType, scopeValue]);
}

module.exports = {
  dialect: impl.dialect,
  ready: impl.ready,
  get: impl.get,
  all: impl.all,
  getSpendByModel,
  getSpendByModelAndTeam,
  getPricingOverrides,
  findApiKey,
  countKeysAndUsers,
  getModelAllowlist,
  getBudgetsForScope,
};
