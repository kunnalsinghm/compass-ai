// routes/feedback.js - POST /api/feedback
//
// The calling application reports a production event worth turning into
// a permanent, reusable evaluation case (blueprint 3.6): a thumbs-down, a
// retry loop, a customer correction, and so on. See tracePipeline.js for
// the trigger vocabulary and what happens next.

const express = require("express");
const router = express.Router();
const { requireAuth } = require("../auth");
const { reportProductionEvent, VALID_TRIGGERS } = require("../tracePipeline");

const GUARD_BASE_URL = (process.env.GUARD_BASE_URL || "http://localhost:4000").replace(/\/$/, "");

router.get("/triggers", requireAuth("read"), (req, res) => {
  res.json({ valid_triggers: VALID_TRIGGERS });
});

router.post("/", requireAuth("write"), async (req, res) => {
  const { trigger, provider, model, request, response, cost_usd, team, customer_id, rubric, note, provider_key } = req.body || {};

  if (!trigger || !provider || !model || !request) {
    return res.status(400).json({ error: "trigger, provider, model, and request are required" });
  }

  try {
    const result = await reportProductionEvent({
      trigger,
      provider,
      model,
      requestBody: request,
      responseJson: response || {},
      costUsd: cost_usd ?? null,
      team: team || req.header("X-Team") || null,
      customerId: customer_id || req.header("X-Customer-Id") || null,
      rubric: rubric || null,
      note: note || null,
      guardBaseUrl: GUARD_BASE_URL,
      guardApiKey: req.header("X-API-Key"),
      providerKey: provider_key || req.header("X-Provider-Key"),
    });
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
