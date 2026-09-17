// shadowTest.js - sends a COPY of eligible traffic to a candidate
// (cheaper) model, without ever changing what the customer-visible
// response was, per blueprint section 3.8. This is deliberately built as
// the upgraded version of Guard's own shadowTest.js: same fire-and-forget,
// non-streaming-only scope (streaming shadow-testing is explicitly
// deferred - see blueprint 3.11's "defer" list - re-assembling and
// diffing a streamed response reliably is real additional work this build
// doesn't take on), but scored through the real evaluation layer
// (evaluation/index.js: deterministic + LLM-judge + lexical) instead of
// word-overlap similarity alone.
//
// Tool-call isolation note (blueprint 3.8): this shadow test only re-runs
// the MODEL call itself against the candidate model - it never executes
// any tool the model asks to call. Tool execution is always the calling
// application's responsibility, one layer above this proxy, so there is
// no real-world side effect to isolate here even when body.tools is
// present. If a future version of Compass ever executes tools on a
// customer's behalf, that isolation requirement would need to be revisited.
//
// Called fire-and-forget from the proxy route AFTER the real response has
// already been sent to the caller - a shadow test must never add latency
// to the customer-visible request path.

const logger = require("./logger");
const pricing = require("./pricing");
const evaluation = require("./evaluation");
const { extractPromptText } = require("./semanticCache");

async function runShadowTest({
  provider,
  primaryModel,
  candidateModel,
  requestBody,
  primaryResponseJson,
  primaryCostUsd,
  team,
  customerId,
  guardBaseUrl,
  guardApiKey,
  providerKey,
  rubric,
}) {
  if (requestBody?.stream) {
    logger.info("Shadow test skipped: streaming requests are not shadow-tested in this build", { provider, primaryModel });
    return;
  }

  const candidateBody = { ...requestBody, model: candidateModel, stream: false };

  let candidateResponseJson;
  try {
    const res = await fetch(`${guardBaseUrl}/api/proxy/${provider}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(guardApiKey ? { "X-API-Key": guardApiKey } : {}),
        "X-Provider-Key": providerKey,
        ...(team ? { "X-Team": team } : {}),
        ...(customerId ? { "X-Customer-Id": customerId } : {}),
        "X-Environment": "shadow-test",
      },
      body: JSON.stringify(candidateBody),
    });
    if (!res.ok) {
      logger.warn("Shadow test candidate call failed", { provider, candidateModel, status: res.status });
      return;
    }
    candidateResponseJson = await res.json();
  } catch (err) {
    logger.warn("Shadow test candidate call errored", { provider, candidateModel, error: err.message });
    return;
  }

  const candidateTokens = extractUsage(provider, candidateResponseJson);
  const candidateCost = await pricing.computeCost({
    provider,
    model: candidateModel,
    input_tokens: candidateTokens.input_tokens,
    output_tokens: candidateTokens.output_tokens,
  });

  const caseId = await evaluation.createEvaluationCase({
    source: "shadow_test",
    provider,
    primaryModel,
    candidateModel,
    inputJson: requestBody,
    rubric,
    team,
  });

  try {
    await evaluation.runEvaluation({
      caseId,
      provider,
      primaryModel,
      candidateModel,
      team,
      primaryResponseJson,
      candidateResponseJson,
      primaryCostUsd,
      candidateCostUsd: candidateCost.rate_found ? candidateCost.cost_usd : null,
      rubric,
      inputSummary: extractPromptText(requestBody).slice(0, 300),
    });
    logger.info("Shadow test completed", { provider, primaryModel, candidateModel, caseId });
  } catch (err) {
    logger.error("Shadow test evaluation failed", { provider, candidateModel, error: err.message });
  }
}

function extractUsage(provider, responseJson) {
  if (provider === "anthropic") {
    return {
      input_tokens: responseJson?.usage?.input_tokens || 0,
      output_tokens: responseJson?.usage?.output_tokens || 0,
    };
  }
  return {
    input_tokens: responseJson?.usage?.prompt_tokens || 0,
    output_tokens: responseJson?.usage?.completion_tokens || 0,
  };
}

module.exports = { runShadowTest, extractUsage };
