const express = require("express");
const router = express.Router();
const { requireAuth } = require("../auth");
const cache = require("../cache");
const { logAudit } = require("../audit");

router.get("/stats", requireAuth("read"), async (req, res) => {
  res.json(await cache.getCacheStats());
});

router.post("/clear", requireAuth("manage_cache"), async (req, res) => {
  await cache.clearCache();
  await logAudit(req.apiKey.key_id, "clear_cache", "exact_cache", {});
  res.json({ cleared: true });
});

module.exports = router;
