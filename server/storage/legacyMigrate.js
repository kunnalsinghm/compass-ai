// storage/legacyMigrate.js - brings a Compass database created BEFORE tenant
// scoping existed up to the current schema, without losing its data.
//
// What changed: every tenant-owned table gained `tenant_key` (default '' =
// the single-tenant deployment every pre-existing database was), and two
// tables (routing_policies, recommendations) changed their uniqueness to
// include it. routing_policies also stops allowing a NULL scope_value: the old
// UNIQUE(scope_type, scope_value, ...) never matched when scope_value was NULL
// (NULLs are distinct), so ON CONFLICT DO NOTHING never fired and every
// recommendation refresh inserted another duplicate global policy row.
//
// Two phases because the new schema creates indexes on tenant_key:
//   pre(db)  - runs BEFORE the schema script: adds the column to existing
//              tables, and (SQLite) moves tables whose uniqueness changed out
//              of the way so the schema script can create the new shape.
//   post(db) - runs AFTER the schema script: copies the moved rows back,
//              de-duplicating routing policies.
// Both are idempotent: on a current database they do nothing.

const TENANT_TABLES = [
  "cache_entries",
  "semantic_cache_entries",
  "routing_policies",
  "routing_decisions_log",
  "evaluation_cases",
  "evaluation_results",
  "recommendations",
  "approvals",
  "savings_ledger",
  "audit_log",
];
const REBUILT = ["routing_policies", "recommendations"];

// ---------------------------------------------------------------- SQLite
function sqliteColumns(raw, table) {
  return raw.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}
function sqliteExists(raw, table) {
  return Boolean(raw.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?`).get(table));
}

const EVAL_CASE_COLUMNS = [
  ["baseline_response", "TEXT"],
  ["trigger_source", "TEXT"],
  ["guard_flag_id", "INTEGER"],
];

function preSqlite(raw) {
  if (sqliteExists(raw, "evaluation_cases")) {
    const have = sqliteColumns(raw, "evaluation_cases");
    for (const [name, type] of EVAL_CASE_COLUMNS) if (!have.includes(name)) raw.exec(`ALTER TABLE evaluation_cases ADD COLUMN ${name} ${type}`);
  }
  for (const table of TENANT_TABLES) {
    if (!sqliteExists(raw, table)) continue;
    const cols = sqliteColumns(raw, table);
    if (cols.includes("tenant_key")) continue;
    if (REBUILT.includes(table)) {
      raw.exec(`ALTER TABLE ${table} RENAME TO ${table}__legacy`);
    } else {
      raw.exec(`ALTER TABLE ${table} ADD COLUMN tenant_key TEXT NOT NULL DEFAULT ''`);
    }
  }
}

function postSqlite(raw) {
  if (sqliteExists(raw, "routing_policies__legacy")) {
    // One policy per (provider, from_model) survives: the most recently updated.
    raw.exec(`
      INSERT INTO routing_policies (tenant_key, scope_type, scope_value, provider, from_model, to_model, rollout_pct, status, recommendation_id, created_at, updated_at)
      SELECT '', scope_type, COALESCE(scope_value, ''), provider, from_model, to_model, rollout_pct, status, recommendation_id, created_at, updated_at
      FROM routing_policies__legacy
      WHERE id IN (SELECT MAX(id) FROM routing_policies__legacy GROUP BY scope_type, COALESCE(scope_value, ''), provider, from_model)
    `);
    raw.exec(`DROP TABLE routing_policies__legacy`);
  }
  if (sqliteExists(raw, "recommendations__legacy")) {
    // Keep the ids: approvals.recommendation_id and routing_policies.recommendation_id point at them.
    raw.exec(`
      INSERT INTO recommendations (id, tenant_key, created_at, updated_at, provider, current_model, suggested_model, window_days,
        current_cost_usd, estimated_suggested_cost_usd, estimated_savings_usd, estimated_savings_pct, affected_events,
        confidence, caveat, evidence_json, status)
      SELECT id, '', created_at, updated_at, provider, current_model, suggested_model, window_days,
        current_cost_usd, estimated_suggested_cost_usd, estimated_savings_usd, estimated_savings_pct, affected_events,
        confidence, caveat, evidence_json, status
      FROM recommendations__legacy
    `);
    raw.exec(`DROP TABLE recommendations__legacy`);
  }
}

// -------------------------------------------------------------- Postgres
async function prePostgres(pool) {
  if ((await pool.query(`SELECT to_regclass('evaluation_cases') AS t`)).rows[0].t) {
    for (const [name, type] of EVAL_CASE_COLUMNS) await pool.query(`ALTER TABLE evaluation_cases ADD COLUMN IF NOT EXISTS ${name} ${type}`);
  }
  for (const table of TENANT_TABLES) {
    const exists = await pool.query(`SELECT to_regclass($1) AS t`, [table]);
    if (!exists.rows[0].t) continue;
    await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS tenant_key TEXT NOT NULL DEFAULT ''`);
  }
  const hasPolicies = (await pool.query(`SELECT to_regclass('routing_policies') AS t`)).rows[0].t;
  if (hasPolicies) {
    await pool.query(`UPDATE routing_policies SET scope_value = '' WHERE scope_value IS NULL`);
    await pool.query(`ALTER TABLE routing_policies ALTER COLUMN scope_value SET DEFAULT ''`);
    await pool.query(`ALTER TABLE routing_policies ALTER COLUMN scope_value SET NOT NULL`);
    await pool.query(
      `DELETE FROM routing_policies WHERE id NOT IN (SELECT MAX(id) FROM routing_policies GROUP BY tenant_key, scope_type, scope_value, provider, from_model)`
    );
  }
  for (const table of REBUILT) {
    const exists = (await pool.query(`SELECT to_regclass($1) AS t`, [table])).rows[0].t;
    if (!exists) continue;
    // Drop the legacy UNIQUE constraint(s); the schema script adds the tenant-aware unique index.
    await pool.query(`
      DO $$ DECLARE r record; BEGIN
        FOR r IN SELECT conname FROM pg_constraint WHERE conrelid = '${table}'::regclass AND contype = 'u' LOOP
          EXECUTE 'ALTER TABLE ${table} DROP CONSTRAINT ' || quote_ident(r.conname);
        END LOOP;
      END $$;`);
  }
}

module.exports = { preSqlite, postSqlite, prePostgres, TENANT_TABLES };
