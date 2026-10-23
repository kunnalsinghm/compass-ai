// routes/proxy.js - POST /api/proxy/:provider
//
// The ONE endpoint a customer's application calls - point your OpenAI/Anthropic
// compatible client's baseURL here instead of at Guard. Compass then, in order:
//
//   0. Resolves identity (the key's bound team wins over X-Team, as in Guard)
//      and redacts PII from the request BEFORE anything is cached or stored, so
//      the cache never holds - or keys on - raw personal data, and one user's
//      answer can't be replayed to another whose prompt differed only by PII.
//   1. Checks the policies that decide who may SEE an answer (model allow-list,
//      region allow-list) - a cache hit never reaches Guard, so without this a
//      key Guard would refuse could read the same answer from the cache.
//   2. Looks in its persisted cache (exact, then semantic). A hit short-circuits
//      Guard and the provider (streaming callers get the answer replayed as SSE)
//      and is reported to Guard as a zero-cost event so attribution stays whole.
//   3. Decides an effective model via the interpretable router.
//   4. Forwards to GUARD's own proxy with the caller's key and EVERY attribution
//      header, so budgets, quarantine, rate limits, residency, injection checks
//      and metering all apply as if the caller had called Guard directly.
//   5. On the way back: passes Guard's X-FinOps-* headers through, captures
//      streams, caches complete answers, records routing savings, and
//      (fire-and-forget) shadow-tests a cheaper model.
//
// Every Compass decision is surfaced as X-Compass-* response headers rather than
// by mutating the provider body, so this stays drop-in for any provider SDK.

const express = require("express");
const router = express.Router();

const { requireAuth } = require("../auth");
const logger = require("../logger");
const cache = require("../cache");
const semanticCache = require("../semanticCache");
const compassRouter = require("../router");
const pricing = require("../pricing");
const guardPolicy = require("../guardPolicy");
const fallback = require("../fallback");
const streaming = require("../streaming");
const { recordSaving } = require("../savings");
const { runShadowTest, extractUsage } = require("../shadowTest");
const { cheaperAlternative } = require("../modelTiers");
const { resolveTeam, realKeyId } = require("../identity");
const { redactValue } = require("../piiRedaction");
const guardClient = require("../guardClient");

const { GUARD_BASE_URL } = guardClient;
const SUPPORTED_PROVIDERS = ["openai", "anthropic"];
const MAX_CAPTURE_BYTES = Number(process.env.COMPASS_MAX_STREAM_CAPTURE_BYTES) || 5 * 1024 * 1024;
const STREAM_TTFB_MS = Number(process.env.COMPASS_GUARD_TIMEOUT_MS) || 125000;

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

// Only complete, plain answers are worth replaying. A tool call replayed from a
// stale answer, a truncated generation, or a filtered response is a surprise.
function isCacheableResponse(provider, json) {
  if (!json || json.error) return false;
  if (provider === "anthropic") {
    if (!Array.isArray(json.content) || json.content.some((b) => b?.type !== "text")) return false;
    return json.stop_reason === "end_turn" || json.stop_reason === "stop_sequence";
  }
  const choice = json.choices?.[0];
  if (!choice || choice.message?.tool_calls || choice.message?.function_call) return false;
  return choice.finish_reason === "stop";
}

function hitHeaders({ type, requestedModel, similarity }) {
  return {
    "X-Compass-Cache": "hit",
    "X-Compass-Cache-Type": type,
    ...(similarity !== undefined ? { "X-Compass-Cache-Similarity": String(similarity) } : {}),
    "X-Compass-Route-Requested-Model": requestedModel,
    "X-Compass-Route-Effective-Model": requestedModel,
  };
}

function sendCached({ res, provider, isStreaming, responseJson, headers }) {
  res.set(headers);
  if (isStreaming) {
    res.status(200).set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    return res.end(streaming.replayAsSse(provider, responseJson));
  }
  return res.status(200).json(responseJson);
}

router.post("/:provider", requireAuth("write"), async (req, res) => {
  const provider = String(req.params.provider || "").toLowerCase();
  if (!SUPPORTED_PROVIDERS.includes(provider)) {
    return res.status(400).json({ error: `Unsupported provider '${provider}'. Supported: ${SUPPORTED_PROVIDERS.join(", ")}` });
  }

  const rawBody = req.body || {};
  const requestedModel = rawBody.model;
  if (!requestedModel || !Array.isArray(rawBody.messages)) {
    return res.status(400).json({ error: "Request body must include 'model' and 'messages', matching the target provider's chat/messages API." });
  }
  const providerKey = req.header("X-Provider-Key");
  if (!providerKey) {
    return res.status(400).json({ error: "Missing X-Provider-Key header (your real OpenAI/Anthropic key - forwarded to Guard, never stored)" });
  }

  // --- Step 0: identity + PII ---------------------------------------------
  const identity = resolveTeam(req.apiKey, req.header("X-Team"));
  if (!identity.ok) return res.status(identity.status).json({ error: identity.error });
  const team = identity.team;
  const customerId = req.header("X-Customer-Id") || null;
  const keyId = realKeyId(req.apiKey);
  const isStreaming = rawBody.stream === true;

  // A key that asked to skip PII redaction (Guard decides whether it may) is
  // handling data that must not be persisted: no caching, no shadow tests.
  const piiBypass = truthy(req.header("X-Disable-PII-Redaction"));
  let body = rawBody;
  if (!piiBypass) body = redactValue(rawBody).value;

  const cacheEnabled = truthy(req.header("X-Compass-Cache")) && !piiBypass;
  const semanticEnabled = truthy(req.header("X-Compass-Semantic-Cache")) && !piiBypass;
  const routingEnabled = truthy(req.header("X-Compass-Enable-Routing"));
  const shadowTestEnabled = truthy(req.header("X-Compass-Enable-Shadow-Test")) && !piiBypass;
  const sampleRateHeader = Number(req.header("X-Compass-Shadow-Test-Sample-Rate"));
  const sampleRate = Math.min(1, Math.max(0, Number.isFinite(sampleRateHeader) && req.header("X-Compass-Shadow-Test-Sample-Rate") ? sampleRateHeader : 0.1));
  const ttlSeconds = Number(req.header("X-Compass-Cache-TTL-Seconds")) || undefined;
  const dialHeader = req.header("X-Compass-Cost-Quality-Dial");
  const dial = dialHeader !== undefined ? Number(dialHeader) : undefined;
  const rubric = parseJsonHeader(req.header("X-Compass-Rubric"));

  try {
    // --- Step 1: who may see an answer (mirrors Guard) ----------------------
    const allow = await guardPolicy.checkModelAllowed({ keyId, team, provider, model: requestedModel });
    if (!allow.allowed) {
      return res.status(403).json({ error: `Model '${requestedModel}' is not allowed for this ${allow.scope}.`, allowed_models: allow.allowedModels });
    }
    const region = req.header("X-Client-Region") || null;
    const residency = await guardPolicy.checkRegionAllowed({ keyId, team, region });
    if (!residency.allowed) {
      return res.status(403).json({ error: `Region '${region}' is not approved for this ${residency.scope}. Approved regions: ${residency.allowedRegions.join(", ")}` });
    }

    // --- Step 2: cache lookup (exact, then semantic) ---------------------------
    let cacheKey = null;
    if (cacheEnabled) {
      cacheKey = cache.makeCacheKey({ provider, model: requestedModel, body, team, customerId });
      const hit = await cache.getCached(cacheKey);
      if (hit) {
        guardClient.reportCacheHit({ req, provider, model: requestedModel, team, cacheType: "exact", wouldHaveCostUsd: hit.costPerHitUsd });
        return sendCached({ res, provider, isStreaming, responseJson: hit.responseJson, headers: hitHeaders({ type: "exact", requestedModel }) });
      }
    }
    if (semanticEnabled) {
      const hit = await semanticCache.findSemanticMatch({ provider, model: requestedModel, team, customerId, body });
      if (hit) {
        guardClient.reportCacheHit({ req, provider, model: requestedModel, team, cacheType: "semantic", wouldHaveCostUsd: hit.costPerHitUsd, similarity: hit.similarity });
        return sendCached({ res, provider, isStreaming, responseJson: hit.responseJson, headers: hitHeaders({ type: "semantic", requestedModel, similarity: hit.similarity }) });
      }
    }

    // --- Step 3: routing -------------------------------------------------------
    let effectiveModel = requestedModel;
    let routeResult = null;
    if (routingEnabled) {
      routeResult = await compassRouter.decideRoute({ provider, requestedModel, body, team, customerId, apiKeyId: keyId, costQualityDial: dial });
      effectiveModel = routeResult.effectiveModel;
    }

    // --- Step 4: forward to Guard ---------------------------------------------
    const forwardHeaders = guardClient.buildForwardHeaders(req, { team, providerKey });
    const forwardBody = { ...body, model: effectiveModel };

    const controller = new AbortController();
    let clientGone = false;
    res.on("close", () => {
      if (!res.writableFinished) {
        clientGone = true;
        controller.abort(); // stop paying for tokens nobody is receiving
      }
    });
    // Non-streaming: cap the whole call. Streaming: cap time-to-first-byte only
    // (a healthy stream may legitimately run for minutes).
    const timer = setTimeout(() => controller.abort(), STREAM_TTFB_MS);
    let guardRes;
    try {
      guardRes = await guardClient.postProxy({ provider, body: forwardBody, headers: forwardHeaders, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    const passthrough = guardClient.guardResponseHeaders(guardRes);
    const degradedByGuard = passthrough["x-finops-degraded"] === "true";

    const decisionHeaders = {
      "X-Compass-Route-Requested-Model": requestedModel,
      "X-Compass-Route-Effective-Model": effectiveModel,
      "X-Compass-Route-Reasons": routeResult ? JSON.stringify(routeResult.reasons).slice(0, 2000) : "[]",
    };

    if (!guardRes.ok) {
      // Provider outage (never a Guard policy refusal) -> optional failover.
      const fb = !isStreaming && fallback.isOutage(guardRes.status) ? await tryFallback() : null;
      if (fb) {
        res.set({ ...passthrough, ...fb.guardHeaders, ...decisionHeaders, "X-Compass-Cache": "miss", "X-Compass-Route-Effective-Model": fb.model, "X-Compass-Route-Provider-Fallback": `${provider}->${fb.provider}` });
        return res.status(200).json(fb.json);
      }
      const errText = await guardRes.text().catch(() => "");
      res.set(passthrough);
      return res.status(guardRes.status).type("application/json").send(errText || JSON.stringify({ error: "Guard proxy call failed" }));
    }

    async function tryFallback() {
      const fbProvider = compassRouter.resolveFallbackProvider(provider);
      const fbKey = req.header("X-Compass-Fallback-Provider-Key");
      if (!fbProvider || !fbKey || !SUPPORTED_PROVIDERS.includes(fbProvider)) return null;
      const fbModel = fallback.equivalentModel(provider, effectiveModel, fbProvider);
      const translated = fbModel && fallback.translateRequest(provider, fbProvider, forwardBody);
      if (!translated) {
        logger.warn("Provider outage but the request can't be failed over faithfully (tools/images/no equivalent model)", { provider, fbProvider });
        return null;
      }
      logger.warn("Guard reported a provider outage, failing over", { provider, status: guardRes.status, fbProvider, fbModel });
      const fbRes = await guardClient.postProxy({
        provider: fbProvider,
        body: { ...translated, model: fbModel },
        headers: guardClient.buildForwardHeaders(req, { team, providerKey: fbKey }),
      });
      if (!fbRes.ok) return null;
      const json = fallback.translateResponse(fbProvider, provider, await fbRes.json());
      return json ? { json, model: fbModel, provider: fbProvider, guardHeaders: guardClient.guardResponseHeaders(fbRes) } : null;
    }

    // --- Step 5a: streaming -----------------------------------------------------
    if (isStreaming) {
      res.status(guardRes.status);
      res.set({ ...passthrough, ...decisionHeaders, "X-Compass-Cache": cacheEnabled || semanticEnabled ? "miss" : "bypass" });
      const contentType = guardRes.headers.get("content-type");
      if (contentType) res.set("Content-Type", contentType);

      let captured = "";
      let overflow = false;
      let streamError = null;
      const decoder = new TextDecoder();
      try {
        for await (const chunk of guardRes.body || []) {
          if (clientGone) break;
          res.write(chunk);
          if (!overflow) {
            captured += decoder.decode(chunk, { stream: true });
            if (captured.length > MAX_CAPTURE_BYTES) {
              overflow = true;
              captured = "";
            }
          }
        }
      } catch (err) {
        streamError = err;
      }
      if (!res.writableEnded) res.end();
      if (clientGone || streamError || overflow) return; // never learn from an incomplete stream

      const assembled = streaming.assembleStream(provider, captured);
      if (assembled) {
        await afterSuccess({ responseJson: assembled, guardCostUsd: null, streamed: true });
      }
      return;
    }

    // --- Step 5b: non-streaming ----------------------------------------------------
    const responseJson = await guardRes.json();
    const guardCost = Number(guardRes.headers.get("x-finops-cost-usd"));
    const { savingsUsd, shadowTestStatus, costUsd } = await afterSuccess({
      responseJson,
      guardCostUsd: guardRes.headers.has("x-finops-cost-usd") && Number.isFinite(guardCost) ? guardCost : null,
      streamed: false,
    });
    res.set({
      ...passthrough,
      ...decisionHeaders,
      "X-Compass-Cache": cacheEnabled || semanticEnabled ? "miss" : "bypass",
      "X-Compass-Cost-Usd": costUsd === null ? "unknown" : String(costUsd),
      "X-Compass-Savings-Usd": String(savingsUsd),
      "X-Compass-Shadow-Test": shadowTestStatus,
    });
    return res.status(200).json(responseJson);

    // Everything Compass does with a COMPLETE successful answer, streamed or not.
    async function afterSuccess({ responseJson: json, guardCostUsd }) {
      const usage = extractUsage(provider, json);
      const computed = await pricing.computeCost({ provider, model: effectiveModel, ...usage });
      // Guard's own metered cost is authoritative when it sent one.
      const costUsd = guardCostUsd !== null ? guardCostUsd : computed.rate_found ? computed.cost_usd : null;

      const cacheable = isCacheableResponse(provider, json);
      if (cacheEnabled && cacheKey && cacheable) {
        await cache.setCached({ cacheKey, provider, model: effectiveModel, team, customerId, responseJson: json, input_tokens: usage.input_tokens, output_tokens: usage.output_tokens, costUsd: costUsd || 0, ttlSeconds });
      }
      if (semanticEnabled && cacheable) {
        await semanticCache.setSemanticCache({ provider, model: requestedModel, team, customerId, body, responseJson: json, input_tokens: usage.input_tokens, output_tokens: usage.output_tokens, costUsd: costUsd || 0, ttlSeconds });
      }

      // Credit Compass only for model switches Compass itself made: if Guard's
      // circuit breaker degraded the model, that saving is Guard's.
      let savingsUsd = 0;
      if (routingEnabled && effectiveModel !== requestedModel && !degradedByGuard && costUsd !== null) {
        const atRequested = await pricing.computeCost({ provider, model: requestedModel, ...usage });
        if (atRequested.rate_found) {
          savingsUsd = Math.round((atRequested.cost_usd - costUsd) * 1e6) / 1e6;
          if (savingsUsd > 0) {
            await recordSaving({ kind: "routing_switch", provider, model: effectiveModel, team, customerId, grossSavingsUsd: savingsUsd, overheadUsd: 0, referenceId: routeResult?.policyId || null });
          }
        }
      }

      let shadowTestStatus = "skipped";
      if (shadowTestEnabled) {
        const candidate = cheaperAlternative(provider, effectiveModel);
        if (!candidate) shadowTestStatus = "no-cheaper-alternative";
        else if (Math.random() >= sampleRate) shadowTestStatus = "not-sampled";
        else {
          shadowTestStatus = "queued";
          // Same attribution as the real request (so the test's spend lands on
          // the same owner) - shadowTest.js adds the shadow-test environment.
          const extraHeaders = {};
          for (const h of ["X-Project-Id", "X-Cost-Center", "X-Feature-Id", "X-Client-Region"]) if (req.header(h)) extraHeaders[h] = req.header(h);
          runShadowTest({
            provider,
            primaryModel: effectiveModel,
            candidateModel: candidate.model,
            requestBody: forwardBody,
            primaryResponseJson: json,
            primaryCostUsd: costUsd,
            team,
            customerId,
            guardBaseUrl: GUARD_BASE_URL,
            guardApiKey: req.header("X-API-Key"),
            providerKey,
            extraHeaders,
            rubric,
          }).catch((err) => logger.error("Fire-and-forget shadow test failed", { error: err.message }));
        }
      }
      return { savingsUsd, shadowTestStatus, costUsd };
    }
  } catch (err) {
    if (res.headersSent) {
      if (!res.writableEnded) res.end();
      return;
    }
    if (err.name === "AbortError" || err.name === "TimeoutError") {
      return res.status(504).json({ error: "Guard did not respond in time" });
    }
    logger.error("Compass proxy request failed", { error: err.message, provider });
    return res.status(502).json({ error: `Compass proxy error: ${err.message}` });
  }
});

module.exports = router;
