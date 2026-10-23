// guardPolicy.js - read-only mirrors of the Guard policy checks that must still
// hold when Compass answers a request WITHOUT forwarding it to Guard.
//
// A cache hit never reaches Guard, so none of Guard's gates run for it. Without
// these mirrors a key that Guard would refuse (a model it may not use, a region
// it may not call from) could simply read the same answer out of Compass's cache.
// Only the gates that are about WHO MAY SEE THIS ANSWER are mirrored here:
//
//   * model allow-list  (most-specific-wins: key list, else team list, else open)
//   * region allow-list (same precedence)
//
// Spend-shaping gates (budget circuit breaker, rate limit, token quota) are not
// mirrored: a cache hit costs nothing and consumes no provider capacity, which
// is the point of the cache. Revocation / quarantine / tenant status are checked
// by auth.js before any route runs.
//
// These read Guard's tables (never write) through guardDb, tenant-scoped.

const guardDb = require("./guardDb");

// Returns { allowed, scope, allowedModels } - same shape as Guard's modelAllowlist.js.
async function checkModelAllowed({ keyId, team, provider, model }) {
  const keyEntries = await guardDb.getModelAllowlist("key", keyId);
  if (keyEntries.length > 0) {
    return { allowed: keyEntries.some((e) => e.provider === provider && e.model === model), scope: "key", allowedModels: keyEntries };
  }
  const teamEntries = await guardDb.getModelAllowlist("team", team);
  if (teamEntries.length > 0) {
    return { allowed: teamEntries.some((e) => e.provider === provider && e.model === model), scope: "team", allowedModels: teamEntries };
  }
  return { allowed: true, scope: null, allowedModels: [] };
}

// Returns { allowed, scope, allowedRegions }. No declared region = nothing to check.
async function checkRegionAllowed({ keyId, team, region }) {
  if (!region) return { allowed: true, scope: null, allowedRegions: [] };
  const keyEntries = await guardDb.getRegionAllowlist("key", keyId);
  if (keyEntries.length > 0) {
    return { allowed: keyEntries.some((e) => e.region === region), scope: "key", allowedRegions: keyEntries.map((e) => e.region) };
  }
  const teamEntries = await guardDb.getRegionAllowlist("team", team);
  if (teamEntries.length > 0) {
    return { allowed: teamEntries.some((e) => e.region === region), scope: "team", allowedRegions: teamEntries.map((e) => e.region) };
  }
  return { allowed: true, scope: null, allowedRegions: [] };
}

module.exports = { checkModelAllowed, checkRegionAllowed };
