// storage/dialectSql.js - dialect-specific SQL fragments for date/string
// functions that differ between SQLite and Postgres. Same approach as
// Guard's server/storage/dialectSql.js (this project's sibling product),
// kept as its own copy rather than a shared npm package since the two
// products are deliberately independently deployable.
//
// These return raw SQL text, not parameterized values - `days` is
// validated as a plain non-negative integer before being inlined, and
// `column` is always a hardcoded identifier from calling code, never
// user input.

const { dialect } = require("./index");

function assertSafeDays(days) {
  if (!Number.isInteger(days) || days < 0) {
    throw new Error(`dialectSql: days must be a non-negative integer, got ${days}`);
  }
  return days;
}

function assertSafeColumn(column) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(column)) {
    throw new Error(`dialectSql: column must be a plain identifier, got ${column}`);
  }
  return column;
}

function sinceDaysAgo(days) {
  assertSafeDays(days);
  return dialect === "postgres"
    ? `TO_CHAR((NOW() AT TIME ZONE 'UTC') - INTERVAL '${days} days', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`
    : `datetime('now', '-${days} days')`;
}

function dayFloorExpr(column) {
  assertSafeColumn(column);
  return dialect === "postgres" ? `TO_CHAR((${column})::timestamp, 'YYYY-MM-DD')` : `date(${column})`;
}

function nowExpr() {
  return dialect === "postgres" ? "NOW()" : "datetime('now')";
}

module.exports = { sinceDaysAgo, dayFloorExpr, nowExpr };
