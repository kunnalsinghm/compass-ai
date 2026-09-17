// routes/router.js - explainability API for routing decisions. Every row
// returned here is a real logged decision from server/router.js's
// decideRoute(), including its plain-English `reasons` - the blueprint's
// requirement that "every enforcement/routing decision should be
// explainable" (sections 2.8, 3.4).

const express = require("express");
const router = express.Router();
const { requireAuth } = require("../auth");
const compassRouter = require("../router");

router.get("/decisions", requireAuth("read"), async (req, res) => {
  const limit = Math.min(500, Number(req.query.limit) || 50);
  const rows = await compassRouter.getRecentDecisions({ limit });
  res.json(
    rows.map((r) => ({
      ...r,
      reasons: JSON.parse(r.reasons_json || "[]"),
      reasons_json: undefined,
    }))
  );
});

// Dry-run: classify a hypothetical request without actually routing
// anything or calling a provider - useful for testing rubric/dial
// behavior from the dashboard before it affects real traffic.
router.post("/explain", requireAuth("read"), async (req, res) => {
  const { classification, reasons, tokenEstimate } = compassRouter.classify(req.body?.request || {});
  const dial = Number(req.body?.costQualityDial);
  const allowsDowngrade = compassRouter.dialAllowsDowngrade(Number.isFinite(dial) ? dial : 5, classification);
  res.json({ classification, reasons, tokenEstimate, dial: Number.isFinite(dial) ? dial : 5, wouldDowngrade: allowsDowngrade });
});

module.exports = router;
