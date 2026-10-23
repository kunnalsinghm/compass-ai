// tracePipeline.js - blueprint section 3.6: converts meaningful production
// events into PERMANENT evaluation cases, closing the loop:
//
//   production event -> failure/regression detection -> permanent
//   evaluation case -> candidate model/router test -> quality gate ->
//   approved or rejected change
//
// Compass has no visibility into a customer's UI (thumbs-down button,
// retry loop, tool errors) - those signals only exist in the calling
// application. So this module exposes a single ingestion point
// (POST /api/feedback, routes/feedback.js) that the customer's app calls
// when one of the blueprint's trigger conditions fires. This build
// intentionally does NOT try to auto-detect retry counts or latency
// regressions from Guard's usage_events (that would require Compass to
// poll Guard continuously and guess at causality) - it's an honest,
// narrower "you tell us, we make it permanent and testable" pipeline
// rather than a claimed-but-unproven auto-detector.

const evaluation = require("./evaluation");
const { runShadowTest } = require("./shadowTest");
const { cheaperAlternative } = require("./modelTiers");
const logger = require("./logger");

const VALID_TRIGGERS = [
  "thumbs_down",
  "high_retry_count",
  "tool_error",
  "quality_score_regression",
  "customer_correction",
  "unusually_high_cost",
  "long_latency",
  "manual",
];

// Records the flagged production event as a permanent evaluation case. If
// a cheaper same-provider alternative exists for the model involved, also
// kicks off an immediate shadow test against it - a regression report is
// exactly the moment you want fresh evidence about whether a cheaper
// model would have done better OR whether the current model is already
// the right choice and something else caused the issue.
async function reportProductionEvent({
  trigger,
  provider,
  model,
  requestBody,
  responseJson,
  costUsd,
  team,
  customerId,
  rubric,
  note,
  guardBaseUrl,
  guardApiKey,
  providerKey,
  extraHeaders,
}) {
  if (!VALID_TRIGGERS.includes(trigger)) {
    throw new Error(`Unknown trigger '${trigger}'. Must be one of: ${VALID_TRIGGERS.join(", ")}`);
  }

  const alternative = cheaperAlternative(provider, model);

  const caseId = await evaluation.createEvaluationCase({
    source: "production_trigger",
    provider,
    primaryModel: model,
    candidateModel: alternative?.model || model,
    inputJson: requestBody,
    rubric: rubric ? { ...rubric, trigger, note } : { type: "none", trigger, note },
    team,
  });

  logger.info("Production event recorded as a permanent evaluation case", { caseId, trigger, provider, model });

  let shadowTestQueued = false;
  if (alternative && providerKey) {
    shadowTestQueued = true;
    // Fire-and-forget - this endpoint should respond immediately, the
    // shadow test and its evaluation run in the background.
    runShadowTest({
      provider,
      primaryModel: model,
      candidateModel: alternative.model,
      requestBody,
      primaryResponseJson: responseJson,
      primaryCostUsd: costUsd,
      team,
      customerId,
      guardBaseUrl,
      guardApiKey,
      providerKey,
      extraHeaders,
      rubric,
    }).catch((err) => logger.error("Trace-pipeline shadow test failed", { error: err.message }));
  }

  return { case_id: caseId, alternative_model: alternative?.model || null, shadow_test_queued: shadowTestQueued };
}

// ---------------------------------------------------------------------
// Automatic production signals from Guard. Guard already detects some of the
// blueprint's triggers on its own (a shadow comparison with low similarity, an
// agent in a retry storm) and stores the prompt/response pair in its
// flagged_test_cases table "as cheap groundwork for Compass". This imports
// them as permanent evaluation cases, once each (guard_flag_id is unique per
// tenant), so the loop closes without the customer having to call
// POST /api/feedback for everything Guard can see itself.
//
// An imported case has the prompt and the response the CURRENT model gave, but
// no provider key (Compass never stores one) - so it is not shadow-tested here.
// It waits as a case; POST /api/evaluation/cases/:id/replay runs it against its
// cheaper candidate whenever someone supplies a key.
// ---------------------------------------------------------------------
const GUARD_SOURCE_TO_TRIGGER = {
  "shadow-low-similarity": "quality_score_regression",
  "high-retry-rate": "high_retry_count",
  "thumbs-down": "thumbs_down",
};

async function syncFlaggedFromGuard({ limit = 200 } = {}) {
  const guardDb = require("./guardDb");
  const after = await evaluation.lastImportedGuardFlagId();
  const rows = await guardDb.getFlaggedTestCases({ afterId: after, limit });
  let imported = 0;
  for (const row of rows) {
    if (!row.provider || !row.model || !row.prompt) continue; // nothing replayable
    const alternative = cheaperAlternative(row.provider, row.model);
    await evaluation.createEvaluationCase({
      source: "production_trigger",
      provider: row.provider,
      primaryModel: row.model,
      candidateModel: alternative?.model || row.model,
      inputJson: { messages: [{ role: "user", content: row.prompt }] },
      rubric: { type: "none", trigger: GUARD_SOURCE_TO_TRIGGER[row.source] || "manual", note: row.reason || null },
      team: null,
      baselineResponse: row.response || null,
      triggerSource: GUARD_SOURCE_TO_TRIGGER[row.source] || "manual",
      guardFlagId: row.id,
    });
    imported++;
  }
  // Rows we skipped still advance nothing, so they are re-read next time; that is
  // cheap (the cursor is the highest imported id) and keeps the logic stateless.
  return { scanned: rows.length, imported };
}

// Re-run a stored case against its candidate model. Needs the caller's headers
// (key + provider key) because the candidate call goes through Guard as them.
async function replayCase(caseRow, { guardBaseUrl, guardApiKey, providerKey, extraHeaders, team }) {
  if (!caseRow.baseline_response) throw new Error("This case has no baseline response to compare against");
  const input = JSON.parse(caseRow.input_json);
  const text = caseRow.baseline_response;
  const primaryResponseJson =
    caseRow.provider === "anthropic"
      ? { content: [{ type: "text", text }] }
      : { choices: [{ message: { role: "assistant", content: text } }] };
  const rubric = caseRow.rubric ? JSON.parse(caseRow.rubric) : null;
  await runShadowTest({
    provider: caseRow.provider,
    primaryModel: caseRow.primary_model,
    candidateModel: caseRow.candidate_model,
    requestBody: input,
    primaryResponseJson,
    primaryCostUsd: null,
    team: team || caseRow.team,
    guardBaseUrl,
    guardApiKey,
    providerKey,
    extraHeaders,
    rubric,
    existingCaseId: caseRow.id,
  });
}

module.exports = { reportProductionEvent, syncFlaggedFromGuard, replayCase, VALID_TRIGGERS };
