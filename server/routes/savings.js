const express = require("express");
const router = express.Router();
const { requireAuth } = require("../auth");
const { getSavingsSummary, getTieredEconomicsReport, getVerifiedSavings, getBaselineVerification } = require("../savings");

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

// Realized, overhead-adjusted savings and the fee they support. Read-only.
router.get("/verified", requireAuth("read"), async (req, res) => {
  const days = Number(req.query.days) || 30;
  const sharePct = req.query.share_pct !== undefined ? Number(req.query.share_pct) : undefined;
  res.json(await getVerifiedSavings({ days, sharePct }));
});

// Audit of the ledger against Guard's own spend data (see savings.js).
router.get("/baseline", requireAuth("read"), async (req, res) => {
  const days = Number(req.query.days) || 30;
  const baselineDays = Number(req.query.baseline_days) || 30;
  res.json(await getBaselineVerification({ days, baselineDays }));
});

module.exports = router;
