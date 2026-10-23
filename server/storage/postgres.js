// storage/postgres.js - Postgres backend for Compass's own database.
// Structurally identical to Guard's server/storage/postgres.js (its
// sibling product in the FinOps Trinity) - same `?` -> `$1,$2...`
// placeholder translation, same RETURNING-id convention, same one-client
// transaction() pattern. Kept as its own copy since Compass and Guard are
// deliberately independently deployable services, but this is genuinely
// the less-exercised path in this codebase: SQLite is what's actually
// been run end-to-end here. If you deploy this on Postgres, run the test
// suite against it first (see README "What's tested vs. what needs your
// own verification").

const { Pool } = require("pg");

const { types } = require("pg");
types.setTypeParser(20 /* int8/bigint */, (val) => parseInt(val, 10));

const dialect = "postgres";

function assertSafeSchemaName(name) {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) {
    throw new Error(`COMPASS_POSTGRES_SCHEMA must be a lowercase identifier, got '${name}'`);
  }
  return name;
}

const rawSchema = process.env.COMPASS_POSTGRES_SCHEMA || "compass";
const schemaName = assertSafeSchemaName(String(rawSchema).toLowerCase());

const poolConfig = { connectionString: process.env.COMPASS_POSTGRES_URL };
poolConfig.options = `-c search_path=${schemaName},public`;
const pool = new Pool(poolConfig);

function toPositional(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

const { SCHEMA_SQL } = require("./schema.postgres");
const ready = (async () => {
  await pool.query(`CREATE SCHEMA IF NOT EXISTS ${schemaName}`);
  await require("./legacyMigrate").prePostgres(pool); // databases created before tenant scoping
  await pool.query(SCHEMA_SQL);
})().catch((err) => {
  throw new Error(`Compass Postgres schema initialization failed: ${err.message}`);
});

async function get(sql, params = []) {
  await ready;
  const result = await pool.query(toPositional(sql), params);
  return result.rows[0];
}

async function all(sql, params = []) {
  await ready;
  const result = await pool.query(toPositional(sql), params);
  return result.rows;
}

async function run(sql, params = []) {
  await ready;
  const result = await pool.query(toPositional(sql), params);
  const lastInsertRowid = result.rows[0]?.id;
  return { lastInsertRowid, changes: result.rowCount };
}

async function exec(sql) {
  await ready;
  await pool.query(sql);
}

async function transaction(fn) {
  await ready;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const tx = {
      get: async (sql, params = []) => {
        const result = await client.query(toPositional(sql), params);
        return result.rows[0];
      },
      all: async (sql, params = []) => {
        const result = await client.query(toPositional(sql), params);
        return result.rows;
      },
      run: async (sql, params = []) => {
        const result = await client.query(toPositional(sql), params);
        const lastInsertRowid = result.rows[0]?.id;
        return { lastInsertRowid, changes: result.rowCount };
      },
    };
    const result = await fn(tx);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Rollback failing shouldn't mask the original error.
    }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { dialect, get, all, run, exec, transaction, pool, ready, schemaName };
