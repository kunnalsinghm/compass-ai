// audit.js - immutable audit trail for Compass's own actions: approving
// or rejecting a recommendation, advancing/rolling back a rollout,
// clearing a cache, editing a routing policy. Same shape as Guard's
// server/audit.js, own table (Compass's storage, not Guard's).

const db = require("./storage");

async function logAudit(actor, action, target, details = {}) {
  await db.run(
    "INSERT INTO audit_log (actor, action, target, details, created_at) VALUES (?, ?, ?, ?, ?)",
    [actor, action, target || null, JSON.stringify(details), new Date().toISOString()]
  );
}

async function getAuditLog({ limit = 100, action, actor } = {}) {
  let query = "SELECT * FROM audit_log";
  const conditions = [];
  const params = [];
  if (action) {
    conditions.push("action = ?");
    params.push(action);
  }
  if (actor) {
    conditions.push("actor = ?");
    params.push(actor);
  }
  if (conditions.length) query += " WHERE " + conditions.join(" AND ");
  query += " ORDER BY id DESC LIMIT ?";
  params.push(limit);
  return db.all(query, params);
}

module.exports = { logAudit, getAuditLog };
