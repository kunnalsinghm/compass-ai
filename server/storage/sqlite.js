// storage/sqlite.js - SQLite backend for Compass's own database.
//
// Deliberately its own file (data/compass.db), separate from Guard's
// data/finops.db - see schema.sqlite.js header for why. Same async-shaped
// wrapper around node:sqlite's synchronous DatabaseSync as Guard uses, so
// route/module code is written once against storage/index.js and works
// unchanged if this ever moves to Postgres (storage/postgres.js).

const path = require("path");
const fs = require("fs");
const { DatabaseSync } = require("node:sqlite");

const DATA_DIR = path.join(__dirname, "..", "..", "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = process.env.COMPASS_DB_PATH || path.join(DATA_DIR, "compass.db");
const raw = new DatabaseSync(DB_PATH);
raw.exec("PRAGMA journal_mode = WAL;");

const { SCHEMA_SQL } = require("./schema.sqlite");
raw.exec(SCHEMA_SQL);

const dialect = "sqlite";

async function get(sql, params = []) {
  return raw.prepare(sql).get(...params);
}

async function all(sql, params = []) {
  return raw.prepare(sql).all(...params);
}

async function run(sql, params = []) {
  const info = raw.prepare(sql).run(...params);
  return { lastInsertRowid: info.lastInsertRowid, changes: info.changes };
}

async function exec(sql) {
  raw.exec(sql);
}

async function transaction(fn) {
  raw.exec("BEGIN");
  try {
    const tx = {
      get: async (sql, params = []) => raw.prepare(sql).get(...params),
      all: async (sql, params = []) => raw.prepare(sql).all(...params),
      run: async (sql, params = []) => {
        const info = raw.prepare(sql).run(...params);
        return { lastInsertRowid: info.lastInsertRowid, changes: info.changes };
      },
    };
    const result = await fn(tx);
    raw.exec("COMMIT");
    return result;
  } catch (err) {
    raw.exec("ROLLBACK");
    throw err;
  }
}

module.exports = { dialect, get, all, run, exec, transaction, raw, ready: Promise.resolve() };
