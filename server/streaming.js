// streaming.js - makes streaming first-class for Compass (blueprint 3.3:
// "Streaming-compatible caching ... store the fully assembled response,
// replay chunks, preserve final usage metadata, mark the response as
// cached, avoid caching incomplete or interrupted streams").
//
// Two jobs:
//   1. assembleStream(provider, sseText) - rebuild the NON-streaming
//      response JSON from a captured SSE body, or return null when the
//      stream was incomplete or contains something we refuse to cache
//      (tool calls). The assembled JSON is what gets cached and shadow
//      tested, so one cache entry serves streaming and non-streaming
//      callers alike (the cache key already ignores `stream`).
//   2. replayAsSse(provider, responseJson) - turn a cached non-streaming
//      response back into a valid SSE body for a streaming caller.
//
// Tool calls are deliberately not cached: replaying a tool call from a
// stale answer is the sort of surprise the blueprint warns about.

function parseSse(text) {
  const events = [];
  for (const block of String(text || "").split(/\r?\n\r?\n/)) {
    let event = null;
    const dataLines = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (!dataLines.length) continue;
    const data = dataLines.join("\n");
    if (data === "[DONE]") {
      events.push({ event, done: true });
      continue;
    }
    try {
      events.push({ event, data: JSON.parse(data) });
    } catch {
      return null; // a malformed chunk means we can't trust the assembly
    }
  }
  return events;
}

function assembleOpenAI(events) {
  let id = null;
  let model = null;
  let content = "";
  let role = "assistant";
  let finish = null;
  let usage = null;
  let sawDone = false;
  for (const e of events) {
    if (e.done) {
      sawDone = true;
      continue;
    }
    const d = e.data;
    if (d.id) id = d.id;
    if (d.model) model = d.model;
    if (d.usage) usage = d.usage;
    const choice = d.choices?.[0];
    if (!choice) continue;
    if (choice.delta?.tool_calls || choice.delta?.function_call) return null;
    if (choice.delta?.role) role = choice.delta.role;
    if (typeof choice.delta?.content === "string") content += choice.delta.content;
    if (choice.finish_reason) finish = choice.finish_reason;
  }
  if (!sawDone || !finish) return null; // interrupted
  if (finish === "tool_calls" || finish === "function_call") return null;
  return {
    id: id || "compass-assembled",
    object: "chat.completion",
    model,
    choices: [{ index: 0, message: { role, content }, finish_reason: finish }],
    usage: usage || { prompt_tokens: 0, completion_tokens: 0 },
  };
}

function assembleAnthropic(events) {
  let message = null;
  const blocks = [];
  let stopReason = null;
  let outputTokens = 0;
  let sawStop = false;
  for (const e of events) {
    if (e.done) continue;
    const d = e.data;
    switch (d.type) {
      case "message_start":
        message = d.message || {};
        break;
      case "content_block_start":
        if (d.content_block?.type && d.content_block.type !== "text") return null; // tool_use / thinking: don't cache
        blocks[d.index] = { type: "text", text: d.content_block?.text || "" };
        break;
      case "content_block_delta":
        if (d.delta?.type === "text_delta" && blocks[d.index]) blocks[d.index].text += d.delta.text || "";
        else if (d.delta?.type && d.delta.type !== "text_delta") return null;
        break;
      case "message_delta":
        if (d.delta?.stop_reason) stopReason = d.delta.stop_reason;
        if (d.usage?.output_tokens != null) outputTokens = d.usage.output_tokens;
        break;
      case "message_stop":
        sawStop = true;
        break;
      case "error":
        return null;
      default:
    }
  }
  if (!message || !sawStop || !stopReason || stopReason === "tool_use") return null;
  return {
    id: message.id || "compass-assembled",
    type: "message",
    role: "assistant",
    model: message.model,
    content: blocks.filter(Boolean),
    stop_reason: stopReason,
    usage: { input_tokens: message.usage?.input_tokens || 0, output_tokens: outputTokens },
  };
}

function assembleStream(provider, sseText) {
  const events = parseSse(sseText);
  if (!events || !events.length) return null;
  return provider === "anthropic" ? assembleAnthropic(events) : assembleOpenAI(events);
}

function sse(eventName, data) {
  return `${eventName ? `event: ${eventName}\n` : ""}data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`;
}

function replayOpenAI(r) {
  const choice = r.choices?.[0] || {};
  const base = { id: r.id, object: "chat.completion.chunk", model: r.model };
  const text = choice.message?.content || "";
  let out = sse(null, { ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] });
  if (text) out += sse(null, { ...base, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
  out += sse(null, { ...base, choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason || "stop" }] });
  out += sse(null, { ...base, choices: [], usage: r.usage });
  out += sse(null, "[DONE]");
  return out;
}

function replayAnthropic(r) {
  let out = sse("message_start", {
    type: "message_start",
    message: { id: r.id, type: "message", role: "assistant", model: r.model, content: [], stop_reason: null, usage: { input_tokens: r.usage?.input_tokens || 0, output_tokens: 0 } },
  });
  (r.content || []).forEach((b, i) => {
    out += sse("content_block_start", { type: "content_block_start", index: i, content_block: { type: "text", text: "" } });
    out += sse("content_block_delta", { type: "content_block_delta", index: i, delta: { type: "text_delta", text: b.text || "" } });
    out += sse("content_block_stop", { type: "content_block_stop", index: i });
  });
  out += sse("message_delta", { type: "message_delta", delta: { stop_reason: r.stop_reason || "end_turn" }, usage: { output_tokens: r.usage?.output_tokens || 0 } });
  out += sse("message_stop", { type: "message_stop" });
  return out;
}

function replayAsSse(provider, responseJson) {
  return provider === "anthropic" ? replayAnthropic(responseJson) : replayOpenAI(responseJson);
}

module.exports = { assembleStream, replayAsSse, parseSse };
