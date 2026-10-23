// guardClient.js - everything Compass says TO Guard over HTTP.
//
// Compass reads Guard's database but never writes it; the only way Compass
// causes anything to happen in Guard is by calling Guard's own API as the
// caller, with the caller's own key - so Guard's auth, tenancy, governance and
// metering apply exactly as if the client had called Guard directly.

const logger = require("./logger");

const GUARD_BASE_URL = (process.env.GUARD_BASE_URL || "http://localhost:4000").replace(/\/$/, "");
const GUARD_TIMEOUT_MS = Number(process.env.COMPASS_GUARD_TIMEOUT_MS) || 125000; // a little above Guard's own upstream timeout

// Request headers Guard understands and that carry attribution or policy
// meaning. ALL are forwarded unchanged: dropping one silently changes what
// Guard records or enforces (agent/task attribution, background exemption,
// cost-center chargeback, data residency).
const FORWARDED_HEADERS = [
  "X-Environment",
  "X-Git-Branch",
  "X-Feature-Id",
  "X-Customer-Id",
  "X-Project-Id",
  "X-Cost-Center",
  "X-Client-Region",
  "X-Agent-Id",
  "X-Session-Id",
  "X-Task-Id",
  "X-Task-Status",
  "X-Workload-Type",
  "X-Disable-PII-Redaction",
];

// Guard-side switches Compass owns instead (see README): forwarding them would
// put two independent caches/shadow-testers in the same request path.
const NEVER_FORWARDED = ["x-enable-cache", "x-enable-semantic-cache", "x-enable-shadow-test", "x-shadow-test-sample-rate", "x-cache-ttl-seconds"];

function buildForwardHeaders(req, { team, providerKey, extra = {} }) {
  const headers = { "Content-Type": "application/json", "X-Provider-Key": providerKey };
  if (req.header("X-API-Key")) headers["X-API-Key"] = req.header("X-API-Key");
  if (team) headers["X-Team"] = team;
  for (const name of FORWARDED_HEADERS) {
    const value = req.header(name);
    if (value && !NEVER_FORWARDED.includes(name.toLowerCase())) headers[name] = value;
  }
  return { ...headers, ...extra };
}

// POST to Guard's proxy. `signal` lets the caller cancel (client disconnect).
function postProxy({ provider, body, headers, signal }) {
  return fetch(`${GUARD_BASE_URL}/api/proxy/${provider}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: signal || AbortSignal.timeout(GUARD_TIMEOUT_MS),
  });
}

// Guard's own response headers that describe what Guard did (degraded,
// PII-redacted, cost, unpriced, quarantine...) - passed through to the client.
function guardResponseHeaders(guardRes) {
  const out = {};
  for (const [k, v] of guardRes.headers.entries()) {
    if (k.startsWith("x-finops-") || k === "retry-after") out[k] = v;
  }
  return out;
}

// A cache hit never reaches Guard, so Guard would never see the request. Tell
// it, as a zero-token event on Guard's own ingest endpoint, so per-agent /
// per-task / per-team request counts and attribution stay complete. Cost is $0
// by construction (Guard prices from tokens); what the hit saved is in the
// payload for anyone reading raw events. Fire-and-forget and best-effort: a
// failure here must never fail or slow the client's request.
function reportCacheHit({ req, provider, model, team, cacheType, wouldHaveCostUsd, similarity }) {
  if (process.env.COMPASS_REPORT_CACHE_HITS === "false") return;
  const body = {
    provider,
    model,
    team: team || undefined,
    environment: req.header("X-Environment") || undefined,
    git_branch: req.header("X-Git-Branch") || undefined,
    feature_id: req.header("X-Feature-Id") || undefined,
    customer_id: req.header("X-Customer-Id") || undefined,
    project_id: req.header("X-Project-Id") || undefined,
    cost_center: req.header("X-Cost-Center") || undefined,
    agent_id: req.header("X-Agent-Id") || undefined,
    session_id: req.header("X-Session-Id") || undefined,
    task_id: req.header("X-Task-Id") || undefined,
    task_status: req.header("X-Task-Status") || undefined,
    workload_type: req.header("X-Workload-Type") || undefined,
    input_tokens: 0,
    output_tokens: 0,
    compass: { cache_hit: true, cache_type: cacheType, similarity: similarity ?? undefined, would_have_cost_usd: wouldHaveCostUsd ?? 0 },
  };
  const headers = { "Content-Type": "application/json" };
  if (req.header("X-API-Key")) headers["X-API-Key"] = req.header("X-API-Key");
  if (req.header("X-Client-Region")) headers["X-Client-Region"] = req.header("X-Client-Region");
  fetch(`${GUARD_BASE_URL}/api/ingest`, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) })
    .then(async (r) => {
      if (!r.ok) logger.warn("Guard rejected a cache-hit report (the client was already served)", { status: r.status });
    })
    .catch((err) => logger.warn("Could not report a cache hit to Guard (the client was already served)", { error: err.message }));
}

module.exports = { GUARD_BASE_URL, FORWARDED_HEADERS, buildForwardHeaders, postProxy, guardResponseHeaders, reportCacheHit };
