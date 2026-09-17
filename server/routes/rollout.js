const express = require("express");
const router = express.Router();
const { requireAuth } = require("../auth");
const rollout = require("../rollout");

router.post("/:recommendationId/approve", requireAuth("manage_recommendations"), async (req, res) => {
  try {
    const policy = await rollout.approveRecommendation(Number(req.params.recommendationId), req.apiKey.key_id, {
      rolloutPct: req.body?.rollout_pct,
      note: req.body?.note,
    });
    res.json({ ok: true, policy });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post("/:recommendationId/reject", requireAuth("manage_recommendations"), async (req, res) => {
  try {
    await rollout.rejectRecommendation(Number(req.params.recommendationId), req.apiKey.key_id, { note: req.body?.note });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post("/:recommendationId/advance", requireAuth("manage_recommendations"), async (req, res) => {
  try {
    const policy = await rollout.advanceRollout(Number(req.params.recommendationId), req.apiKey.key_id, Number(req.body?.rollout_pct), {
      note: req.body?.note,
    });
    res.json({ ok: true, policy });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post("/:recommendationId/rollback", requireAuth("manage_recommendations"), async (req, res) => {
  try {
    await rollout.rollback(Number(req.params.recommendationId), req.apiKey.key_id, { note: req.body?.note });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Manually trigger the same evidence-based auto-rollback sweep that
// would otherwise run on a schedule (see server/index.js).
router.post("/auto-check", requireAuth("manage_recommendations"), async (req, res) => {
  const rolledBack = await rollout.checkAutoRollbackConditions();
  res.json({ checked: true, rolled_back: rolledBack });
});

router.get("/ladder", requireAuth("read"), (req, res) => {
  res.json({ ladder: rollout.ROLLOUT_LADDER });
});

module.exports = router;
