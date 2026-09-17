const express = require("express");
const router = express.Router();
const { requireAuth } = require("../auth");
const db = require("../storage");
const evaluation = require("../evaluation");
const { logAudit } = require("../audit");

// Recent evaluation results, optionally filtered to one model pair -
// what backs the "Evaluation & shadow testing" dashboard tab.
router.get("/results", requireAuth("read"), async (req, res) => {
  const { provider, primary_model, candidate_model } = req.query;
  const limit = Math.min(200, Number(req.query.limit) || 50);
  let rows;
  if (provider && primary_model && candidate_model) {
    rows = await db.all(
      `SELECT * FROM evaluation_results WHERE provider = ? AND primary_model = ? AND candidate_model = ? ORDER BY id DESC LIMIT ?`,
      [provider, primary_model, candidate_model, limit]
    );
  } else {
    rows = await db.all(`SELECT * FROM evaluation_results ORDER BY id DESC LIMIT ?`, [limit]);
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

module.exports = router;
