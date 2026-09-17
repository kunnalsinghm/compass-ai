// cache.js - persisted exact-match caching for Compass's proxy.
//
// This is the "Compass AI" version of Guard's cache.js: same idea (same
// provider + model + message content -> same cached response), but
// PERSISTED (survives restarts, visible in the dashboard as a real
// savings number) instead of an in-memory Map, and every hit is recorded
// as a line item in the savings ledger (savings.js) so "Compass reduced
// your bill" is a number backed by rows, not a marketing claim.
//
// Opt-in per request (X-Compass-Cache: true), same reasoning as Guard:
// silently returning a cached response could surprise a caller expecting
// fresh variation each time.
//
// Cache key includes team + customer_id, per the blueprint's explicit
// warning: "Never return a cached response across tenants or incompatible
// authorization contexts."

const crypto = require("crypto");
const db = require("./storage");
const { recordSaving } = require("./savings");

const DEFAULT_TTL_SECONDS = Number(process.env.COMPASS_CACHE_TTL_SECONDS) || 300;

function makeCacheKey({ provider, model, body, team, customerId }) {
  const { stream, stream_options, ...cacheable } = body || {};
  const normalized = JSON.stringify({ provider, model, team: team || null, customerId: customerId || null, ...cacheable });
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

// Returns the cached response (and records the savings ledger entry) on a
// hit, or null on a miss/expiry. Fire-and-forget-safe: never throws.
async function getCached(cacheKey) {
  const row = await db.get("SELECT * FROM cache_entries WHERE cache_key = ?", [cacheKey]);
  if (!row) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    await db.run("DELETE FROM cache_entries WHERE id = ?", [row.id]);
    return null;
  }

  await db.run("UPDATE cache_entries SET hit_count = hit_count + 1 WHERE id = ?", [row.id]);

  await recordSaving({
    kind: "exact_cache_hit",
    provider: row.provider,
    model: row.model,
    team: row.team,
    customerId: row.customer_id,
    grossSavingsUsd: row.cost_per_hit_usd,
    overheadUsd: 0,
    referenceId: row.id,
  });

  return {
    responseJson: JSON.parse(row.response_json),
    input_tokens: row.input_tokens,
    output_tokens: row.output_tokens,
  };
}

async function setCached({ cacheKey, provider, model, team, customerId, responseJson, input_tokens, output_tokens, costUsd, ttlSeconds }) {
  const expiresAt = new Date(Date.now() + (ttlSeconds || DEFAULT_TTL_SECONDS) * 1000).toISOString();
  await db.run(
    `INSERT INTO cache_entries
       (cache_key, provider, model, team, customer_id, response_json, input_tokens, output_tokens, cost_per_hit_usd, hit_count, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
     ON CONFLICT(cache_key) DO UPDATE SET
       response_json = excluded.response_json,
       input_tokens = excluded.input_tokens,
       output_tokens = excluded.output_tokens,
       cost_per_hit_usd = excluded.cost_per_hit_usd,
       expires_at = excluded.expires_at`,
    [cacheKey, provider, model, team || null, customerId || null, JSON.stringify(responseJson), input_tokens || 0, output_tokens || 0, costUsd || 0, expiresAt]
  );
}

async function getCacheStats() {
  const totals = await db.get(
    `SELECT COUNT(*) AS entries, COALESCE(SUM(hit_count), 0) AS total_hits FROM cache_entries`
  );
  const savings = await db.get(
    `SELECT COALESCE(SUM(net_savings_usd), 0) AS net_savings_usd, COUNT(*) AS hit_events
     FROM savings_ledger WHERE kind = 'exact_cache_hit'`
  );
  return {
    current_size: Number(totals?.entries || 0),
    total_hits: Number(totals?.total_hits || 0),
    net_savings_usd: Math.round(Number(savings?.net_savings_usd || 0) * 1e6) / 1e6,
  };
}

async function clearCache() {
  await db.run("DELETE FROM cache_entries");
}

module.exports = { makeCacheKey, getCached, setCached, getCacheStats, clearCache, DEFAULT_TTL_SECONDS };
