// routes/proxy.js - POST /api/proxy/:provider
//
// This is the ONE endpoint a customer's application actually calls -
// point your OpenAI/Anthropic-compatible client's baseURL here instead
// of at Guard directly. Compass then, in order:
//
//   1. Checks its own persisted cache (exact, then semantic if enabled) -
//      a hit means Guard and the real provider are never even called.
//   2. Decides an effective model via the interpretable router (only if
//      X-Compass-Enable-Routing: true - like Guard's own opt-in features,
//      changing the model is behavior-changing enough to require opt-in).
//   3. Forwards the (possibly re-routed) request to GUARD's own proxy,
//      which applies budgets, PII redaction, prompt-injection heuristics,
//      quarantine, and rate limits, and calls the real provider - Compass
//      never talks to a model provider directly, and never re-implements
//      Guard's governance.
//   4. On success: caches the response if requested, records any routing
//      savings to the ledger, and (fire-and-forget, non-streaming only)
//      kicks off a shadow test if requested.
//
// Every decision is surfaced back as response headers (X-Compass-*)
// rather than mutating the provider response body, so this stays a
// drop-in-compatible proxy for any OpenAI/Anthropic SDK.

const express = require("express");
const { Readable } = require("stream");
const router = express.Router();

const { requireAuth } = require("../auth");
const logger = require("../logger");
const cache = require("../cache");
const semanticCache = require("../semanticCache");
const compassRouter = require("../router");
const pricing = require("../pricing");
const { recordSaving } = require("../savings");
const { runShadowTest, extractUsage } = require("../shadowTest");
const { CHEAPER_ALTERNATIVES } = require("../modelTiers");

const GUARD_BASE_URL = (process.env.GUARD_BASE_URL || "http://localhost:4000").replace(/\/$/, "");
const SUPPORTED_PROVIDERS = ["openai", "anthropic"];

function truthy(headerValue) {
  return String(headerValue || "").toLowerCase() === "true";
}

function parseJsonHeader(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

async function forwardToGuard({ provider, body, headers }) {
  return fetch(`${GUARD_BASE_URL}/api/proxy/${provider}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

router.post("/:provider", requireAuth("write"), async (req, res) => {
  const provider = String(req.params.provider || "").toLowerCase();
  if (!SUPPORTED_PROVIDERS.includes(provider)) {
    return res.status(400).json({ error: `Unsupported provider '${provider}'. Supported: ${SUPPORTED_PROVIDERS.join(", ")}` });
  }

  const body = req.body || {};
  const requestedModel = body.model;
  if (!requestedModel || !Array.isArray(body.messages)) {
    return res.status(400).json({ error: "Request body must include 'model' and 'messages', matching the target provider's chat/messages API." });
  }

  const providerKey = req.header("X-Provider-Key");
  if (!providerKey) {
    return res.status(400).json({ error: "Missing X-Provider-Key header (your real OpenAI/Anthropic key - forwarded to Guard, never stored)" });
  }

  const team = req.header("X-Team") || null;
  const customerId = req.header("X-Customer-Id") || null;
  const apiKeyId = req.apiKey?.key_id || null;
  const isStreaming = Boolean(body.stream);

  const cacheEnabled = truthy(req.header("X-Compass-Cache")) && !isStreaming;
  const semanticEnabled = truthy(req.header("X-Compass-Semantic-Cache")) && !isStreaming;
  const routingEnabled = truthy(req.header("X-Compass-Enable-Routing"));
  const shadowTestEnabled = truthy(req.header("X-Compass-Enable-Shadow-Test")) && !isStreaming;
  const sampleRate = Math.min(1, Math.max(0, Number(req.header("X-Compass-Shadow-Test-Sample-Rate")) || 0.1));
  const ttlSeconds = Number(req.header("X-Compass-Cache-TTL-Seconds")) || undefined;
  const dialHeader = req.header("X-Compass-Cost-Quality-Dial");
  const dial = dialHeader !== undefined ? Number(dialHeader) : undefined;
  const rubric = parseJsonHeader(req.header("X-Compass-Rubric"));

  try {
    // --- Step 1: cache lookup (exact, then semantic) -------------------
    let cacheKey = null;
    if (cacheEnabled) {
      cacheKey = cache.makeCacheKey({ provider, model: requestedModel, body, team, customerId });
      const hit = await cache.getCached(cacheKey);
      if (hit) {
        res.set({
          "X-Compass-Cache": "hit",
          "X-Compass-Cache-Type": "exact",
          "X-Compass-Route-Requested-Model": requestedModel,
          "X-Compass-Route-Effective-Model": requestedModel,
        });
        return res.status(200).json(hit.responseJson);
      }
    }
    if (semanticEnabled) {
      const semanticHit = await semanticCache.findSemanticMatch({ provider, model: requestedModel, team, customerId, body });
      if (semanticHit) {
        res.set({
          "X-Compass-Cache": "hit",
          "X-Compass-Cache-Type": "semantic",
          "X-Compass-Cache-Similarity": String(semanticHit.similarity),
          "X-Compass-Route-Requested-Model": requestedModel,
          "X-Compass-Route-Effective-Model": requestedModel,
        });
        return res.status(200).json(semanticHit.responseJson);
      }
    }

    // --- Step 2: routing decision --------------------------------------
    let effectiveModel = requestedModel;
    let routeResult = null;
    if (routingEnabled) {
      routeResult = await compassRouter.decideRoute({ provider, requestedModel, body, team, customerId, apiKeyId, costQualityDial: dial });
      effectiveModel = routeResult.effectiveModel;
    }

    // --- Step 3: forward to Guard (governance + metering + real call) --
    const forwardHeaders = {
      "X-Provider-Key": providerKey,
      ...(req.header("X-API-Key") ? { "X-API-Key": req.header("X-API-Key") } : {}),
      ...(team ? { "X-Team": team } : {}),
      ...(req.header("X-Environment") ? { "X-Environment": req.header("X-Environment") } : {}),
      ...(req.header("X-Git-Branch") ? { "X-Git-Branch": req.header("X-Git-Branch") } : {}),
      ...(req.header("X-Feature-Id") ? { "X-Feature-Id": req.header("X-Feature-Id") } : {}),
      ...(customerId ? { "X-Customer-Id": customerId } : {}),
      ...(req.header("X-Client-Region") ? { "X-Client-Region": req.header("X-Client-Region") } : {}),
      // Deliberately NOT forwarding Guard's own X-Enable-Cache /
      // X-Enable-Semantic-Cache / X-Enable-Shadow-Test headers even if the
      // caller set them - when routing through Compass, use Compass's own
      // X-Compass-* headers instead, to avoid two independent caching
      // layers disagreeing about what "cached" means.
    };
    const forwardBody = { ...body, model: effectiveModel };

    const guardRes = await forwardToGuard({ provider, body: forwardBody, headers: forwardHeaders });

    if (!guardRes.ok) {
      const fallbackProvider = compassRouter.resolveFallbackProvider(provider);
      if (fallbackProvider && !isStreaming) {
        logger.warn("Guard call failed, attempting provider fallback", { provider, status: guardRes.status, fallbackProvider });
        const { cheapestModel } = require("../modelTiers");
        const fallbackModel = cheapestModel(fallbackProvider);
        if (fallbackModel) {
          const fallbackRes = await forwardToGuard({
            provider: fallbackProvider,
            body: { ...forwardBody, model: fallbackModel },
            headers: forwardHeaders,
          });
          if (fallbackRes.ok) {
            const fallbackJson = await fallbackRes.json();
            res.set({
              "X-Compass-Cache": "miss",
              "X-Compass-Route-Requested-Model": requestedModel,
              "X-Compass-Route-Effective-Model": fallbackModel,
              "X-Compass-Route-Provider-Fallback": `${provider}->${fallbackProvider}`,
            });
            return res.status(200).json(fallbackJson);
          }
        }
      }
      const errText = await guardRes.text().catch(() => "");
      return res.status(guardRes.status).type("application/json").send(errText || JSON.stringify({ error: "Guard proxy call failed" }));
    }

    // --- Streaming: pipe straight through, skip cache/shadow-test -------
    if (isStreaming) {
      res.status(guardRes.status);
      res.set("X-Compass-Cache", "bypass");
      res.set("X-Compass-Route-Requested-Model", requestedModel);
      res.set("X-Compass-Route-Effective-Model", effectiveModel);
      const contentType = guardRes.headers.get("content-type");
      if (contentType) res.set("Content-Type", contentType);
      if (guardRes.body) {
        Readable.fromWeb(guardRes.body).pipe(res);
      } else {
        res.end();
      }
      return;
    }

    // --- Non-streaming: read response, cache it, record savings ---------
    const responseJson = await guardRes.json();
    const usage = extractUsage(provider, responseJson);
    const actualCost = await pricing.computeCost({ provider, model: effectiveModel, ...usage });

    if (cacheEnabled && cacheKey) {
      await cache.setCached({
        cacheKey,
        provider,
        model: effectiveModel,
        team,
        customerId,
        responseJson,
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        costUsd: actualCost.rate_found ? actualCost.cost_usd : 0,
        ttlSeconds,
      });
    }
    if (semanticEnabled) {
      await semanticCache.setSemanticCache({
        provider,
        model: requestedModel,
        team,
        customerId,
        body,
        responseJson,
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        costUsd: actualCost.rate_found ? actualCost.cost_usd : 0,
        ttlSeconds,
      });
    }

    let savingsUsd = 0;
    if (routingEnabled && effectiveModel !== requestedModel && actualCost.rate_found) {
      const costAtRequested = await pricing.computeCost({ provider, model: requestedModel, ...usage });
      if (costAtRequested.rate_found) {
        savingsUsd = Math.round((costAtRequested.cost_usd - actualCost.cost_usd) * 1e6) / 1e6;
        if (savingsUsd > 0) {
          await recordSaving({
            kind: "routing_switch",
            provider,
            model: effectiveModel,
            team,
            customerId,
            grossSavingsUsd: savingsUsd,
            overheadUsd: 0,
            referenceId: routeResult?.policyId || null,
          });
        }
      }
    }

    let shadowTestStatus = "skipped";
    if (shadowTestEnabled) {
      const candidate = CHEAPER_ALTERNATIVES[`${provider}/${effectiveModel}`];
      if (candidate && Math.random() < sampleRate) {
        shadowTestStatus = "queued";
        runShadowTest({
          provider,
          primaryModel: effectiveModel,
          candidateModel: candidate.model,
          requestBody: forwardBody,
          primaryResponseJson: responseJson,
          primaryCostUsd: actualCost.rate_found ? actualCost.cost_usd : null,
          team,
          customerId,
          guardBaseUrl: GUARD_BASE_URL,
          guardApiKey: req.header("X-API-Key"),
          providerKey,
          rubric,
        }).catch((err) => logger.error("Fire-and-forget shadow test failed", { error: err.message }));
      } else if (!candidate) {
        shadowTestStatus = "no-cheaper-alternative";
      } else {
        shadowTestStatus = "not-sampled";
      }
    }

    res.set({
      "X-Compass-Cache": "miss",
      "X-Compass-Route-Requested-Model": requestedModel,
      "X-Compass-Route-Effective-Model": effectiveModel,
      "X-Compass-Route-Reasons": routeResult ? JSON.stringify(routeResult.reasons).slice(0, 2000) : "[]",
      "X-Compass-Cost-Usd": actualCost.rate_found ? String(actualCost.cost_usd) : "unknown",
      "X-Compass-Savings-Usd": String(savingsUsd),
      "X-Compass-Shadow-Test": shadowTestStatus,
    });
    return res.status(200).json(responseJson);
  } catch (err) {
    logger.error("Compass proxy request failed", { error: err.message, provider });
    return res.status(502).json({ error: `Compass proxy error: ${err.message}` });
  }
});

module.exports = router;
