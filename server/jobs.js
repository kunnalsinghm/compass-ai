// jobs.js - Compass's scheduled work, run once PER TENANT.
//
// In multi-tenant Guard there is no single "the" database: each tenant has its
// own spend, budgets, policies and evidence. A job therefore iterates Guard's
// active tenants (the same set Guard's own scheduler uses) and runs inside that
// tenant's context (tenantContext.js), with one tenant's failure isolated from
// every other tenant's run. Single-tenant deployments get one pass in the
// empty-tenant context - the behaviour Compass always had.

const guardDb = require("./guardDb");
const logger = require("./logger");
const tenantContext = require("./tenantContext");
const recommend = require("./recommend");
const rollout = require("./rollout");
const tracePipeline = require("./tracePipeline");

async function runForEachTenant(name, fn) {
  let tenants;
  try {
    tenants = await guardDb.listActiveTenants();
  } catch (err) {
    logger.error(`Job '${name}': could not list Guard's tenants`, { error: err.message });
    return { ran: 0, failed: 1 };
  }
  let ran = 0;
  let failed = 0;
  for (const t of tenants) {
    try {
      await tenantContext.runWithTenant({ tenantId: t.id, tenantSchema: t.schema_name }, fn);
      ran++;
    } catch (err) {
      failed++;
      logger.error(`Job '${name}' failed for a tenant (others unaffected)`, { tenant: t.id ?? "single", error: err.message });
    }
  }
  return { ran, failed };
}

const refreshRecommendations = () => runForEachTenant("recommendations", () => recommend.generateRecommendations({ days: 30 }));
const autoRollbackSweep = () => runForEachTenant("auto-rollback", () => rollout.checkAutoRollbackConditions());
const importGuardSignals = () => runForEachTenant("guard-signals", () => tracePipeline.syncFlaggedFromGuard());

function startSchedules(env = process.env) {
  const every = (minutes, job) => {
    if (minutes > 0) setInterval(() => job().catch((e) => logger.error("Scheduled job failed", { error: e.message })), minutes * 60 * 1000).unref();
  };
  every(Number(env.COMPASS_RECOMMENDATION_REFRESH_MINUTES ?? 60), refreshRecommendations);
  every(Number(env.COMPASS_AUTO_ROLLBACK_CHECK_MINUTES ?? 15), autoRollbackSweep);
  every(Number(env.COMPASS_GUARD_SIGNAL_SYNC_MINUTES ?? 30), importGuardSignals);
}

module.exports = { runForEachTenant, refreshRecommendations, autoRollbackSweep, importGuardSignals, startSchedules };
