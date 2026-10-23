// test() wrapper that runs every test body inside a single-tenant context
// (tenant_key ''), like an authenticated request would. Tenant-scoped modules
// fail closed outside a context, so tests must not call them bare.
const nodeTest = require("node:test");
const tenantContext = require("../../server/tenantContext");

function wrap(fn) {
  return fn.length >= 1 ? (t, done) => tenantContext.runWithTenant({}, () => fn(t, done)) : () => tenantContext.runWithTenant({}, () => fn());
}
function test(name, opts, fn) {
  if (typeof opts === "function") return nodeTest(name, wrap(opts));
  return nodeTest(name, opts, wrap(fn));
}
Object.assign(test, nodeTest, { after: nodeTest.after, before: nodeTest.before });
module.exports = test;
