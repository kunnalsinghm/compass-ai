// semanticCache.js - persisted near-duplicate prompt caching.
//
// Same two-mode design as Guard's server/semanticCache.js (this project's
// sibling product), for a consistent mental model across both products:
//
//   "local" (default) - zero-dependency term-frequency cosine similarity.
//   Catches reworded-but-lexically-similar prompts. This is word overlap,
//   not real semantic understanding ("cat" vs "feline" won't match).
//
//   "embedding" - calls an OpenAI-compatible embeddings endpoint for a
//   real semantic vector. Requires COMPASS_EMBEDDING_API_KEY. Anthropic has
//   no first-party embeddings endpoint, so Anthropic proxy requests use
//   the same OpenAI-compatible embeddings API when this mode is active.
//   Falls back to local mode (warned once) on any embedding failure.
//
// What's genuinely different from Guard's version:
//   1. PERSISTED (survives restarts) - this is meant to be Compass's
//      real, measurable optimization layer, not an in-memory proxy trick.
//   2. Scoped by system_fingerprint + tools_fingerprint, not just
//      provider/model - per the blueprint's explicit warning that "a
//      semantically similar question may require a different answer if
//      the underlying data changed" (a changed system prompt or tool
//      definition changes what a correct answer even looks like).
//   3. Scoped by team/customer_id for tenant isolation, same rule as
//      exact-match caching.
//   4. Optional sensitive-route exclusion via COMPASS_SEMANTIC_CACHE_EXCLUDE
//      (comma-separated substrings; a prompt containing any of them is
//      never cached, semantically or exactly - a coarse but honest
//      customer-configurable control, not a claim of real PII detection).

const crypto = require("crypto");
const db = require("./storage");
const { recordSaving } = require("./savings");

const MODE = (process.env.COMPASS_SEMANTIC_CACHE_MODE || "local").toLowerCase();
const THRESHOLD = Number(process.env.COMPASS_SEMANTIC_CACHE_THRESHOLD) || (MODE === "embedding" ? 0.9 : 0.92);
const EMBEDDING_API_KEY = process.env.COMPASS_EMBEDDING_API_KEY || null;
const EMBEDDING_BASE_URL = process.env.COMPASS_EMBEDDING_BASE_URL || "https://api.openai.com/v1/embeddings";
const EXCLUDE_PATTERNS = (process.env.COMPASS_SEMANTIC_CACHE_EXCLUDE || "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const DEFAULT_TTL_SECONDS = Number(process.env.COMPASS_SEMANTIC_CACHE_TTL_SECONDS) || 300;

let warnedEmbeddingFailure = false;

function extractPromptText(body) {
  const parts = [];
  if (typeof body?.system === "string") parts.push(body.system);
  else if (Array.isArray(body?.system)) {
    for (const block of body.system) if (typeof block?.text === "string") parts.push(block.text);
  }
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  for (const msg of messages) {
    const content = msg?.content;
    if (typeof content === "string") parts.push(content);
    else if (Array.isArray(content)) {
      for (const block of content) if (typeof block?.text === "string") parts.push(block.text);
    }
  }
  return parts.join("\n").trim();
}

function fingerprintSystem(body) {
  const text = typeof body?.system === "string" ? body.system : JSON.stringify(body?.system || "");
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function fingerprintTools(body) {
  const tools = body?.tools || body?.functions || null;
  return crypto.createHash("sha256").update(JSON.stringify(tools || null)).digest("hex").slice(0, 16);
}

function isExcluded(promptText) {
  if (!EXCLUDE_PATTERNS.length) return false;
  const lower = promptText.toLowerCase();
  return EXCLUDE_PATTERNS.some((p) => lower.includes(p));
}

function tokenize(text) {
  return (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function termFrequency(tokens) {
  const tf = {};
  for (const t of tokens) tf[t] = (tf[t] || 0) + 1;
  return tf;
}

function cosineSimilarityLocal(tfA, tfB) {
  let dot = 0,
    normA = 0,
    normB = 0;
  for (const term of Object.keys(tfA)) {
    normA += tfA[term] * tfA[term];
    if (tfB[term]) dot += tfA[term] * tfB[term];
  }
  for (const term of Object.keys(tfB)) normB += tfB[term] * tfB[term];
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function cosineSimilarityEmbedding(vecA, vecB) {
  if (!Array.isArray(vecA) || !Array.isArray(vecB) || vecA.length !== vecB.length || vecA.length === 0) return 0;
  let dot = 0,
    normA = 0,
    normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dot += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function getEmbedding(text) {
  const res = await fetch(EMBEDDING_BASE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${EMBEDDING_API_KEY}` },
    body: JSON.stringify({ model: "text-embedding-3-small", input: text }),
  });
  if (!res.ok) throw new Error(`Embedding request failed: HTTP ${res.status}`);
  const json = await res.json();
  const vector = json?.data?.[0]?.embedding;
  if (!Array.isArray(vector)) throw new Error("Embedding response missing vector");
  return vector;
}

async function computeVector(text) {
  if (MODE === "embedding" && EMBEDDING_API_KEY) {
    try {
      const vector = await getEmbedding(text);
      return { vectorType: "embedding", vector };
    } catch (err) {
      if (!warnedEmbeddingFailure) {
        warnedEmbeddingFailure = true;
        require("./logger").warn("Semantic cache embedding request failed, falling back to local mode", {
          error: err.message,
        });
      }
    }
  }
  return { vectorType: "local", vector: termFrequency(tokenize(text)) };
}

// Returns { responseJson, input_tokens, output_tokens, similarity } on a
// hit above threshold, or null. Never throws - a broken embeddings call
// degrades to a cache miss, not a proxy failure.
async function findSemanticMatch({ provider, model, team, customerId, body, threshold }) {
  try {
    const promptText = extractPromptText(body);
    if (!promptText || isExcluded(promptText)) return null;

    const systemFp = fingerprintSystem(body);
    const toolsFp = fingerprintTools(body);
    const { vectorType, vector } = await computeVector(promptText);
    const effectiveThreshold = threshold ?? THRESHOLD;

    const candidates = await db.all(
      `SELECT * FROM semantic_cache_entries
       WHERE provider = ? AND model = ? AND vector_type = ?
         AND system_fingerprint = ? AND tools_fingerprint = ?
         AND (team IS ? OR team = ?)
         AND (customer_id IS ? OR customer_id = ?)
         AND expires_at > ?`,
      [
        provider,
        model,
        vectorType,
        systemFp,
        toolsFp,
        team || null,
        team || null,
        customerId || null,
        customerId || null,
        new Date().toISOString(),
      ]
    );

    let best = null;
    for (const entry of candidates) {
      const entryVector = JSON.parse(entry.vector_json);
      const sim =
        vectorType === "embedding" ? cosineSimilarityEmbedding(vector, entryVector) : cosineSimilarityLocal(vector, entryVector);
      if (sim >= effectiveThreshold && (!best || sim > best.similarity)) {
        best = { entry, similarity: sim };
      }
    }

    if (!best) return null;

    await db.run("UPDATE semantic_cache_entries SET hit_count = hit_count + 1 WHERE id = ?", [best.entry.id]);
    await recordSaving({
      kind: "semantic_cache_hit",
      provider,
      model,
      team,
      customerId,
      grossSavingsUsd: best.entry.cost_per_hit_usd,
      overheadUsd: 0,
      referenceId: best.entry.id,
    });

    return {
      responseJson: JSON.parse(best.entry.response_json),
      input_tokens: best.entry.input_tokens,
      output_tokens: best.entry.output_tokens,
      similarity: Math.round(best.similarity * 1000) / 1000,
    };
  } catch (err) {
    require("./logger").error("Semantic cache lookup failed, treating as miss", { error: err.message });
    return null;
  }
}

async function setSemanticCache({ provider, model, team, customerId, body, responseJson, input_tokens, output_tokens, costUsd, ttlSeconds }) {
  try {
    const promptText = extractPromptText(body);
    if (!promptText || isExcluded(promptText)) return;

    const systemFp = fingerprintSystem(body);
    const toolsFp = fingerprintTools(body);
    const { vectorType, vector } = await computeVector(promptText);
    const expiresAt = new Date(Date.now() + (ttlSeconds || DEFAULT_TTL_SECONDS) * 1000).toISOString();

    await db.run(
      `INSERT INTO semantic_cache_entries
         (provider, model, team, customer_id, system_fingerprint, tools_fingerprint, prompt_text, vector_type, vector_json,
          response_json, input_tokens, output_tokens, cost_per_hit_usd, hit_count, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      [
        provider,
        model,
        team || null,
        customerId || null,
        systemFp,
        toolsFp,
        promptText.slice(0, 4000),
        vectorType,
        JSON.stringify(vector),
        JSON.stringify(responseJson),
        input_tokens || 0,
        output_tokens || 0,
        costUsd || 0,
        expiresAt,
      ]
    );
  } catch (err) {
    require("./logger").error("Semantic cache write failed (response still returned to caller)", { error: err.message });
  }
}

async function getSemanticCacheStats() {
  const totals = await db.get(`SELECT COUNT(*) AS entries, COALESCE(SUM(hit_count),0) AS total_hits FROM semantic_cache_entries`);
  const savings = await db.get(
    `SELECT COALESCE(SUM(net_savings_usd),0) AS net_savings_usd FROM savings_ledger WHERE kind = 'semantic_cache_hit'`
  );
  return {
    mode: MODE,
    threshold: THRESHOLD,
    current_size: Number(totals?.entries || 0),
    total_hits: Number(totals?.total_hits || 0),
    net_savings_usd: Math.round(Number(savings?.net_savings_usd || 0) * 1e6) / 1e6,
  };
}

async function clearSemanticCache() {
  await db.run("DELETE FROM semantic_cache_entries");
}

module.exports = {
  findSemanticMatch,
  setSemanticCache,
  getSemanticCacheStats,
  clearSemanticCache,
  extractPromptText,
  fingerprintSystem,
  fingerprintTools,
  tokenize,
  termFrequency,
  cosineSimilarityLocal,
  cosineSimilarityEmbedding,
  MODE,
  THRESHOLD,
};
