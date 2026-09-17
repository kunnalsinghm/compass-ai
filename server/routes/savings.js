const express = require("express");
const router = express.Router();
const { requireAuth } = require("../auth");
const { getSavingsSummary, getTieredEconomicsReport } = require("../savings");

router.get("/summary", requireAuth("read"), async (req, res) => {
  const days = Number(req.query.days) || 30;
  res.json(await getSavingsSummary({ days }));
});

// Blueprint section 3.10 - the same real traffic under three policies,
// so cost/quality trade-offs are visible rather than a bare percentage.
router.get("/tiered-economics", requireAuth("read"), async (req, res) => {
  const days = Number(req.query.days) || 30;
  res.json(await getTieredEconomicsReport({ days }));
});

module.exports = router;
