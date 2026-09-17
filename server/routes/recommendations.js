const express = require("express");
const router = express.Router();
const { requireAuth } = require("../auth");
const recommend = require("../recommend");
const { logAudit } = require("../audit");

router.get("/", requireAuth("read"), async (req, res) => {
  res.json(await recommend.listRecommendations({ status: req.query.status }));
});

router.get("/:id", requireAuth("read"), async (req, res) => {
  const rec = await recommend.getRecommendation(Number(req.params.id));
  if (!rec) return res.status(404).json({ error: "Recommendation not found" });
  res.json(rec);
});

// Regenerates recommendations from current Guard spend + current
// evaluation evidence. Never touches approval status - see recommend.js.
router.post("/generate", requireAuth("manage_recommendations"), async (req, res) => {
  const days = Number(req.body?.days) || 30;
  const created = await recommend.generateRecommendations({ days });
  await logAudit(req.apiKey.key_id, "generate_recommendations", null, { days, count: created.length });
  res.status(201).json({ generated: created.length, recommendations: created });
});

module.exports = router;
