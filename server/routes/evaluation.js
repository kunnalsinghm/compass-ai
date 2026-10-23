const express = require("express");
const router = express.Router();
const { requireAuth } = require("../auth");
const db = require("../storage");
const evaluation = require("../evaluation");
const { logAudit } = require("../audit");
const tracePipeline = require("../tracePipeline");
const { resolveTeam } = require("../identity");
const { tenantKey } = require("../tenantContext");

// Recent evaluation results, optionally filtered to one model pair -
// what backs the "Evaluation & shadow testing" dashboard tab.
router.get("/results", requireAuth("read"), async (req, res) => {
  const { provider, primary_model, candidate_model } = req.query;
  const limit = Math.min(200, Number(req.query.limit) || 50);
  let rows;
  if (provider && primary_model && candidate_model) {
    rows = await db.all(
      `SELECT * FROM evaluation_results WHERE tenant_key = ? AND provider = ? AND primary_model = ? AND candidate_model = ? ORDER BY id DESC LIMIT ?`,
      [tenantKey(), provider, primary_model, candidate_model, limit]
    );
  } else {
    rows = await db.all(`SELECT * FROM evaluation_results WHERE tenant_key = ? ORDER BY id DESC LIMIT ?`, [tenantKey(), limit]);
  }
  res.json(rows);
});

router.get("/stats", requireAuth("read"), async (req, res) => {
  const { provider, primary_model, candidate_model } = req.query;
  if (!provider || !primary_model || !candidate_model) {
    return res.status(400).json({ error: "provider, primary_model, and candidate_model query params are required" });
  }
  res.json(await evaluation.getEvaluationStatsForPair(provider, primary_model, candidate_model));
});

// Blueprint 3.5's "human feedback" labels - acceptable / unacceptable /
// needs_review / better / worse / unsafe / incomplete - attached to an
// existing evaluation_results row.
router.post("/results/:id/label", requireAuth("manage_recommendations"), async (req, res) => {
  const { label } = req.body || {};
  try {
    await evaluation.recordHumanLabel(Number(req.params.id), label);
    await logAudit(req.apiKey.key_id, "human_label", `evaluation_result:${req.params.id}`, { label });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Permanent evaluation cases (shadow tests, production triggers, Guard imports).
router.get("/cases", requireAuth("read"), async (req, res) => {
  res.json(await evaluation.listEvaluationCases({ limit: req.query.limit }));
});

// Import whatever Guard has flagged since the last import (also runs on a schedule).
router.post("/sync-guard", requireAuth("manage_recommendations"), async (req, res) => {
  res.json(await tracePipeline.syncFlaggedFromGuard());
});

// Replay a stored case against its cheaper candidate. The candidate call goes
// through Guard as the caller, so it needs the caller's provider key.
router.post("/cases/:id/replay", requireAuth("manage_recommendations"), async (req, res) => {
  const row = await evaluation.getEvaluationCase(Number(req.params.id));
  if (!row) return res.status(404).json({ error: "Evaluation case not found" });
  const providerKey = req.header("X-Provider-Key");
  if (!providerKey) return res.status(400).json({ error: "Missing X-Provider-Key header (forwarded to Guard, never stored)" });
  const identity = resolveTeam(req.apiKey, req.header("X-Team"));
  if (!identity.ok) return res.status(identity.status).json({ error: identity.error });
  const extraHeaders = {};
  for (const h of ["X-Project-Id", "X-Cost-Center", "X-Feature-Id"]) if (req.header(h)) extraHeaders[h] = req.header(h);
  try {
    await tracePipeline.replayCase(row, { guardBaseUrl: require("../guardClient").GUARD_BASE_URL, guardApiKey: req.header("X-API-Key"), providerKey, extraHeaders, team: identity.team });
    res.json({ ok: true, case_id: row.id });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
