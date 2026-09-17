const express = require("express");
const router = express.Router();
const { requireAuth } = require("../auth");
const semanticCache = require("../semanticCache");
const { logAudit } = require("../audit");

router.get("/stats", requireAuth("read"), async (req, res) => {
  res.json(await semanticCache.getSemanticCacheStats());
});

router.post("/clear", requireAuth("manage_cache"), async (req, res) => {
  await semanticCache.clearSemanticCache();
  await logAudit(req.apiKey.key_id, "clear_cache", "semantic_cache", {});
  res.json({ cleared: true });
});

module.exports = router;
