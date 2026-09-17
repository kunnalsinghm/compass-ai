// compass-client.js - same zero-dependency wrapper shape as Guard's
// sdk/finops-client.js (this project's sibling product), pointed at
// Compass's proxy instead of Guard's directly. Point this at Compass;
// Compass forwards to Guard on your behalf.
//
// Usage:
//   const { CompassClient } = require('./compass-client');
//   const client = new CompassClient({
//     baseUrl: 'http://localhost:4100',
//     apiKey: 'fk_...',        // the same platform API key Guard issued
//     providerKey: 'sk-...',   // your real OpenAI/Anthropic key
//     team: 'growth',
//   });
//
//   const response = await client.chat('openai', {
//     model: 'gpt-4o',
//     messages: [{ role: 'user', content: 'hello' }],
//   }, { cache: true, routing: true, costQualityDial: 6 });
//
//   // Streaming (cache/shadow-testing are skipped for streaming in this
//   // build - see server/routes/proxy.js - but routing still applies):
//   for await (const chunk of client.chatStream('openai', body, { routing: true })) {
//     process.stdout.write(chunk);
//   }

class CompassClient {
  constructor({ baseUrl, apiKey, providerKey, team, customerId, environment, gitBranch }) {
    if (!baseUrl) throw new Error("CompassClient requires baseUrl");
    if (!apiKey) throw new Error("CompassClient requires apiKey");
    if (!providerKey) throw new Error("CompassClient requires providerKey");
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
    this.providerKey = providerKey;
    this.team = team;
    this.customerId = customerId;
    this.environment = environment;
    this.gitBranch = gitBranch;
  }

  _headers(extra = {}) {
    const headers = {
      "Content-Type": "application/json",
      "X-API-Key": this.apiKey,
      "X-Provider-Key": this.providerKey,
      ...extra,
    };
    if (this.team) headers["X-Team"] = this.team;
    if (this.customerId) headers["X-Customer-Id"] = this.customerId;
    if (this.environment) headers["X-Environment"] = this.environment;
    if (this.gitBranch) headers["X-Git-Branch"] = this.gitBranch;
    return headers;
  }

  async chat(
    provider,
    body,
    { cache = false, cacheTtlSeconds, semanticCache = false, routing = false, costQualityDial, shadowTest = false, shadowTestSampleRate, rubric } = {}
  ) {
    const extraHeaders = {};
    if (cache) extraHeaders["X-Compass-Cache"] = "true";
    if (cacheTtlSeconds) extraHeaders["X-Compass-Cache-TTL-Seconds"] = String(cacheTtlSeconds);
    if (semanticCache) extraHeaders["X-Compass-Semantic-Cache"] = "true";
    if (routing) extraHeaders["X-Compass-Enable-Routing"] = "true";
    if (costQualityDial !== undefined) extraHeaders["X-Compass-Cost-Quality-Dial"] = String(costQualityDial);
    if (shadowTest) extraHeaders["X-Compass-Enable-Shadow-Test"] = "true";
    if (shadowTestSampleRate !== undefined) extraHeaders["X-Compass-Shadow-Test-Sample-Rate"] = String(shadowTestSampleRate);
    if (rubric) extraHeaders["X-Compass-Rubric"] = JSON.stringify(rubric);

    const res = await fetch(`${this.baseUrl}/api/proxy/${provider}`, {
      method: "POST",
      headers: this._headers(extraHeaders),
      body: JSON.stringify({ ...body, stream: false }),
    });

    const json = await res.json();
    if (!res.ok) {
      const err = new Error(json.error?.message || json.error || `Request failed: ${res.status}`);
      err.status = res.status;
      err.body = json;
      throw err;
    }

    return {
      ...json,
      _compass: {
        cache: res.headers.get("x-compass-cache"),
        cacheType: res.headers.get("x-compass-cache-type"),
        requestedModel: res.headers.get("x-compass-route-requested-model"),
        effectiveModel: res.headers.get("x-compass-route-effective-model"),
        reasons: safeParseJson(res.headers.get("x-compass-route-reasons")),
        costUsd: res.headers.get("x-compass-cost-usd"),
        savingsUsd: res.headers.get("x-compass-savings-usd"),
      },
    };
  }

  async *chatStream(provider, body, { routing = false, costQualityDial } = {}) {
    const extraHeaders = {};
    if (routing) extraHeaders["X-Compass-Enable-Routing"] = "true";
    if (costQualityDial !== undefined) extraHeaders["X-Compass-Cost-Quality-Dial"] = String(costQualityDial);

    const res = await fetch(`${this.baseUrl}/api/proxy/${provider}`, {
      method: "POST",
      headers: this._headers(extraHeaders),
      body: JSON.stringify({ ...body, stream: true }),
    });

    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      const err = new Error(json.error?.message || json.error || `Request failed: ${res.status}`);
      err.status = res.status;
      throw err;
    }

    const decoder = new TextDecoder();
    for await (const chunk of res.body) {
      yield decoder.decode(chunk, { stream: true });
    }
  }
}

function safeParseJson(value) {
  if (!value) return [];
  try {
    return JSON.parse(value);
  } catch {
    return [];
  }
}

module.exports = { CompassClient };
