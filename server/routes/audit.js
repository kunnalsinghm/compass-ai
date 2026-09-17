const express = require("express");
const router = express.Router();
const { requireAuth } = require("../auth");
const { getAuditLog } = require("../audit");

router.get("/", requireAuth("read"), async (req, res) => {
  res.json(await getAuditLog({ limit: Math.min(500, Number(req.query.limit) || 100), action: req.query.action, actor: req.query.actor }));
});

module.exports = router;
