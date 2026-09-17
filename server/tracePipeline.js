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
const { CHEAPER_ALTERNATIVES } = require("./modelTiers");
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
}) {
  if (!VALID_TRIGGERS.includes(trigger)) {
    throw new Error(`Unknown trigger '${trigger}'. Must be one of: ${VALID_TRIGGERS.join(", ")}`);
  }

  const alternative = CHEAPER_ALTERNATIVES[`${provider}/${model}`];

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
      rubric,
    }).catch((err) => logger.error("Trace-pipeline shadow test failed", { error: err.message }));
  }

  return { case_id: caseId, alternative_model: alternative?.model || null, shadow_test_queued: shadowTestQueued };
}

module.exports = { reportProductionEvent, VALID_TRIGGERS };
