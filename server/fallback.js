// fallback.js - cross-provider failover for a PROVIDER OUTAGE (not a cost
// decision). Blueprint 3.4: "fallback must not violate customer policy".
//
// Why this is its own module, and deliberately narrow:
//
//   * An OpenAI chat body is not an Anthropic messages body (system prompt
//     location, required max_tokens, content shape) and the response shapes
//     differ too. Sending one provider's body to the other, or returning the
//     other provider's response to a client that speaks the first, simply
//     breaks the client. So failover here TRANSLATES the request to the
//     fallback provider's shape and the response back to the shape the caller
//     asked in.
//   * Translation only covers plain text conversations. Anything it cannot
//     carry faithfully - tools/functions, images, structured-output modes,
//     multiple choices - makes translateRequest return null, and the caller
//     gets the original error instead of a subtly wrong answer.
//   * It needs the caller's key FOR THE FALLBACK PROVIDER
//     (X-Compass-Fallback-Provider-Key). The key sent for the primary provider
//     is the wrong secret for another vendor and must never be sent there.
//   * It only triggers on provider-outage statuses (see isOutage), never on a
//     Guard policy refusal (402 budget, 403 allow-list/identity, 429 limits,
//     400 injection/PII): those are decisions, and retrying them elsewhere
//     would be an attempt to route around the control.
//   * The attempt still goes through Guard, so the fallback call is
//     allow-listed, budgeted, redacted, rate-limited and metered like any other.

const { ladderFor, TIER_LADDER } = require("./modelTiers");

// Statuses that mean "the provider (or the path to it) is down", as opposed to
// "Guard said no". 504/502/503 are what Guard returns for timeouts/upstream
// failures; a bare 500/529 is the provider's own.
const OUTAGE_STATUSES = new Set([500, 502, 503, 504, 529]);
function isOutage(status) {
  return OUTAGE_STATUSES.has(Number(status));
}

function overrideMap(env = process.env) {
  // COMPASS_FALLBACK_MODELS="openai:gpt-4o,anthropic:claude-sonnet"
  const map = {};
  for (const pair of String(env.COMPASS_FALLBACK_MODELS || "").split(",")) {
    const [provider, model] = pair.split(":").map((s) => s.trim());
    if (provider && model) map[provider.toLowerCase()] = model;
  }
  return map;
}

// The model to use on `toProvider` in place of fromProvider/fromModel: an
// operator override if configured, else the SAME quality tier on the other
// provider (premium -> premium). Failover is for availability, so it must not
// quietly drop to the cheapest model. Null when no equivalent tier exists.
function equivalentModel(fromProvider, fromModel, toProvider, env = process.env) {
  const override = overrideMap(env)[String(toProvider).toLowerCase()];
  if (override) return override;
  const tier = ladderFor(fromProvider, fromModel)?.tier;
  if (!tier) return null;
  const ladder = TIER_LADDER[String(toProvider).toLowerCase()] || [];
  return ladder.find((e) => e.tier === tier)?.model || null;
}

function plainText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content) && content.every((b) => b && (b.type === "text" || b.type === "input_text") && typeof b.text === "string")) {
    return content.map((b) => b.text).join("\n");
  }
  return null; // images / documents / tool blocks - not translatable
}

const UNSUPPORTED_OPENAI_FIELDS = ["tools", "functions", "tool_choice", "function_call", "response_format", "logprobs", "audio", "modalities"];
const UNSUPPORTED_ANTHROPIC_FIELDS = ["tools", "tool_choice", "thinking", "mcp_servers", "container"];

// Returns the request body in toProvider's shape (model NOT set - the caller
// chooses it), or null if the conversation cannot be translated faithfully.
function translateRequest(fromProvider, toProvider, body) {
  if (fromProvider === toProvider) return { ...body };
  if (!body || !Array.isArray(body.messages)) return null;

  if (fromProvider === "openai" && toProvider === "anthropic") {
    if (UNSUPPORTED_OPENAI_FIELDS.some((f) => body[f] !== undefined) || (body.n && body.n > 1)) return null;
    const system = [];
    const messages = [];
    for (const m of body.messages) {
      const text = plainText(m?.content);
      if (text === null) return null;
      if (m.role === "system" || m.role === "developer") system.push(text);
      else if (m.role === "user" || m.role === "assistant") messages.push({ role: m.role, content: text });
      else return null; // tool / function roles
    }
    if (!messages.length) return null;
    const out = { messages, max_tokens: body.max_tokens || body.max_completion_tokens || 1024 };
    if (system.length) out.system = system.join("\n\n");
    if (body.temperature !== undefined) out.temperature = Math.min(1, Math.max(0, body.temperature));
    if (body.top_p !== undefined) out.top_p = body.top_p;
    if (body.stop) out.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop];
    return out;
  }

  if (fromProvider === "anthropic" && toProvider === "openai") {
    if (UNSUPPORTED_ANTHROPIC_FIELDS.some((f) => body[f] !== undefined)) return null;
    const messages = [];
    if (body.system) {
      const sys = plainText(body.system);
      if (sys === null) return null;
      messages.push({ role: "system", content: sys });
    }
    for (const m of body.messages) {
      const text = plainText(m?.content);
      if (text === null) return null;
      if (m.role !== "user" && m.role !== "assistant") return null;
      messages.push({ role: m.role, content: text });
    }
    const out = { messages };
    if (body.max_tokens) out.max_tokens = body.max_tokens;
    if (body.temperature !== undefined) out.temperature = body.temperature;
    if (body.top_p !== undefined) out.top_p = body.top_p;
    if (body.stop_sequences) out.stop = body.stop_sequences;
    return out;
  }

  return null;
}

const ANTHROPIC_TO_OPENAI_STOP = { end_turn: "stop", stop_sequence: "stop", max_tokens: "length", refusal: "content_filter" };
const OPENAI_TO_ANTHROPIC_STOP = { stop: "end_turn", length: "max_tokens", content_filter: "refusal" };

// Response from `fromProvider` (the one that actually answered) into the shape
// `toProvider` (the one the caller speaks) expects. Null if it carries
// something we can't represent (e.g. a tool call).
function translateResponse(fromProvider, toProvider, json) {
  if (fromProvider === toProvider) return json;
  if (fromProvider === "anthropic" && toProvider === "openai") {
    const blocks = Array.isArray(json?.content) ? json.content : [];
    if (blocks.some((b) => b?.type !== "text")) return null;
    const input = json?.usage?.input_tokens || 0;
    const output = json?.usage?.output_tokens || 0;
    return {
      id: json.id,
      object: "chat.completion",
      model: json.model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: blocks.map((b) => b.text).join("") },
          finish_reason: ANTHROPIC_TO_OPENAI_STOP[json.stop_reason] || "stop",
        },
      ],
      usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output },
    };
  }
  if (fromProvider === "openai" && toProvider === "anthropic") {
    const choice = json?.choices?.[0];
    if (!choice || choice.message?.tool_calls || choice.message?.function_call) return null;
    const text = typeof choice.message?.content === "string" ? choice.message.content : "";
    return {
      id: json.id,
      type: "message",
      role: "assistant",
      model: json.model,
      content: [{ type: "text", text }],
      stop_reason: OPENAI_TO_ANTHROPIC_STOP[choice.finish_reason] || "end_turn",
      stop_sequence: null,
      usage: { input_tokens: json?.usage?.prompt_tokens || 0, output_tokens: json?.usage?.completion_tokens || 0 },
    };
  }
  return null;
}

module.exports = { isOutage, equivalentModel, translateRequest, translateResponse, OUTAGE_STATUSES };
