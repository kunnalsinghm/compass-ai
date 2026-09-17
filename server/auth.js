// auth.js - Compass's own auth is deliberately thin: it validates every
// request's X-API-Key against GUARD's api_keys table (via guardDb.js) and
// reuses Guard's exact role vocabulary (admin, budget-manager, developer,
// viewer). Compass does not maintain a separate user/key store - one
// identity system for the whole FinOps Trinity, per the blueprint's
// "existing trust in the vendor" rationale for why later products build
// on Guard's foundation instead of duplicating it. Create keys in Guard
// (POST /api/keys there); use the same key here.
//
// Two Compass-specific permissions are layered on top of Guard's four
// base ones - see ROLE_PERMISSIONS below - since Guard has no concept of
// "approve a model-switch recommendation" or "clear Compass's cache."

const guardDb = require("./guardDb");
const logger = require("./logger");

let warnedBootstrapAccess = false;

const BASE_ROLE_PERMISSIONS = {
  admin: ["read", "write", "manage_keys", "manage_budgets", "approve_quarantine"],
  "budget-manager": ["read", "manage_budgets"],
  developer: ["read", "write"],
  viewer: ["read"],
};

// Compass-specific permissions, layered on the same roles Guard already
// defines. admin and budget-manager can approve/rollout cost-optimization
// changes (a budget/cost decision); only admin can clear caches or edit
// routing policy scope (an operational/safety-relevant action).
const COMPASS_EXTRA_PERMISSIONS = {
  admin: ["manage_recommendations", "manage_cache", "manage_routing"],
  "budget-manager": ["manage_recommendations"],
  developer: [],
  viewer: [],
};

function hasPermission(role, permission) {
  const base = BASE_ROLE_PERMISSIONS[role] || [];
  const extra = COMPASS_EXTRA_PERMISSIONS[role] || [];
  return base.includes(permission) || extra.includes(permission);
}

// requireAuth('read') / requireAuth('manage_recommendations') etc.
//
// Bootstrap mode mirrors Guard's: if Guard itself has no keys or users
// yet (a brand new install of the whole stack), Compass also serves
// requests as admin, so a first-time operator can explore both dashboards
// before creating a key. This closes the moment Guard's own bootstrap
// window closes (the instant Guard has a key/user), since both read the
// same table.
function requireAuth(permission) {
  return async (req, res, next) => {
    try {
      const keyId = req.header("X-API-Key");

      if (!keyId) {
        const { keys, users } = await guardDb.countKeysAndUsers();
        if (keys === 0 && users === 0) {
          if (!warnedBootstrapAccess) {
            warnedBootstrapAccess = true;
            logger.warn(
              "Guard has no API keys or users yet - Compass is serving requests as admin under bootstrap mode. Create a key in Guard (POST /api/keys) to close this window."
            );
          }
          req.apiKey = { role: "admin", key_id: "bootstrap", label: "bootstrap (no Guard keys/users yet)" };
          return next();
        }
        return res.status(401).json({ error: "Missing X-API-Key header" });
      }

      const row = await guardDb.findApiKey(keyId);
      if (!row) {
        return res.status(401).json({ error: "Invalid API key (checked against Guard's key store)" });
      }
      if (row.status === "revoked") {
        return res.status(403).json({ error: "This API key has been revoked in Guard" });
      }
      if (row.status === "quarantined" && permission !== "read") {
        return res.status(403).json({ error: "This API key is quarantined in Guard - read-only until approved" });
      }
      if (permission && !hasPermission(row.role, permission)) {
        return res.status(403).json({ error: `Role '${row.role}' lacks '${permission}' permission` });
      }

      req.apiKey = row;
      next();
    } catch (err) {
      logger.error("Auth check against Guard failed", { error: err.message });
      res.status(503).json({ error: `Could not validate against Guard: ${err.message}` });
    }
  };
}

module.exports = { requireAuth, hasPermission, BASE_ROLE_PERMISSIONS, COMPASS_EXTRA_PERMISSIONS };
