// tenantContext.js - which Guard tenant the current piece of work belongs to.
//
// Guard can run multi-tenant (FINOPS_MULTI_TENANT=true): every tenant gets its
// own Postgres schema and the api_keys table moves to a shared control-plane
// schema. Compass has to respect that boundary in two places:
//
//   1. Reading Guard's data (guardDb.js) - spend, budgets, allow-lists and
//      pricing come from the CALLER'S tenant schema, never another tenant's.
//   2. Compass's own tables (cache, routing policies, recommendations,
//      evaluation evidence, savings ledger, audit log) - every row carries a
//      tenant_key and every query filters on it.
//
// Rather than thread a tenant argument through every function, the tenant is
// carried in AsyncLocalStorage, set once by requireAuth (HTTP requests) or by
// runForEachTenant (background jobs). It FAILS CLOSED: reading the tenant
// outside any context throws, so a code path that forgot to establish one
// errors loudly instead of silently reading or writing across tenants.
//
// Single-tenant deployments use the empty tenant key "" and no schema - the
// same shapes Compass always had.

const { AsyncLocalStorage } = require("node:async_hooks");

const storage = new AsyncLocalStorage();

const SAFE_SCHEMA_RE = /^[a-z_][a-z0-9_]*$/;

function multiTenant(env = process.env) {
  return env.COMPASS_MULTI_TENANT === "true" || env.FINOPS_MULTI_TENANT === "true";
}

function makeContext({ tenantId = null, tenantSchema = null } = {}) {
  if (tenantSchema && !SAFE_SCHEMA_RE.test(tenantSchema)) {
    throw new Error(`Refusing unsafe tenant schema name '${tenantSchema}'`);
  }
  return Object.freeze({
    tenantKey: tenantId === null || tenantId === undefined ? "" : String(tenantId),
    tenantSchema: tenantSchema || null,
  });
}

// Runs fn with the given tenant as the ambient context. Everything fn starts
// (including fire-and-forget promises) inherits it.
function runWithTenant(ctx, fn) {
  return storage.run(makeContext(ctx), fn);
}

function current() {
  const ctx = storage.getStore();
  if (!ctx) {
    throw new Error(
      "No tenant context: this code ran outside an authenticated request or runWithTenant(). Refusing to guess which tenant's data to use."
    );
  }
  return ctx;
}

const tenantKey = () => current().tenantKey;
const tenantSchema = () => current().tenantSchema;
const hasContext = () => Boolean(storage.getStore());

module.exports = { runWithTenant, current, tenantKey, tenantSchema, hasContext, multiTenant, SAFE_SCHEMA_RE };
