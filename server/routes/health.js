const express = require("express");
const router = express.Router();
const db = require("../storage");
const guardDb = require("../guardDb");

router.get("/", async (req, res) => {
  const status = { ok: true, time: new Date().toISOString(), compass_db: "unknown", guard_db: "unknown" };

  try {
    await db.get("SELECT 1 AS ok");
    status.compass_db = "ok";
  } catch (err) {
    status.compass_db = `error: ${err.message}`;
    status.ok = false;
  }

  try {
    await guardDb.ready;
    await guardDb.get("SELECT 1 AS ok");
    status.guard_db = "ok";
  } catch (err) {
    status.guard_db = `error: ${err.message}`;
    status.ok = false;
  }

  if (status.guard_db === "ok") {
    const schema = await guardDb.checkSchema();
    status.guard_schema = schema.ok ? "ok" : schema.problems;
    if (!schema.ok) status.ok = false;
  }

  res.status(status.ok ? 200 : 503).json(status);
});

module.exports = router;
