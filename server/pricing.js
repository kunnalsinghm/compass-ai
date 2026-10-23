// pricing.js - Compass's pricing lookups.
//
// Guard is the single source of truth for pricing OVERRIDES (an operator
// corrected a rate via Guard's POST /api/pricing/override) - Compass reads
// those live via guardDb so the two products never disagree about what a
// model costs. This file keeps its own copy of the illustrative BASELINE
// catalogue only as a fallback for models Guard has no override for,
// mirroring Guard's own pricing.js baseline numbers. If you update
// Guard's baseline catalogue, update this one too - see the honest-scope
// note in Guard's own pricing.js about these being illustrative
// placeholders, not live vendor pricing.

const guardDb = require("./guardDb");
const tenantContext = require("./tenantContext");

const BASELINE_CATALOGUE = {
  openai: {
    "gpt-4o": { input_per_1k: 0.0025, output_per_1k: 0.01 },
    "gpt-4o-mini": { input_per_1k: 0.00015, output_per_1k: 0.0006 },
    // --- Added in the governance-hardening pass: real model IDs that were
    // previously unpriced (and therefore silently metered as $0). Snapshot
    // as of 2026-09-19, cross-checked across several published price lists -
    // NOT read from a provider's own billing API, so re-verify before
    // relying on them for invoicing, and use POST /api/pricing/override to
    // correct any rate that drifts. Models whose published rates disagreed
    // between sources (e.g. promotional tiers) are deliberately left out so
    // they surface as "unpriced" instead of being guessed.
    "gpt-4.1": { input_per_1k: 0.002, output_per_1k: 0.008 },
    "gpt-4.1-mini": { input_per_1k: 0.0004, output_per_1k: 0.0016 },
    "gpt-4.1-nano": { input_per_1k: 0.0001, output_per_1k: 0.0004 },
    "o3": { input_per_1k: 0.002, output_per_1k: 0.008 },
    "o4-mini": { input_per_1k: 0.0011, output_per_1k: 0.0044 },
    "gpt-5": { input_per_1k: 0.00125, output_per_1k: 0.01 },
    "gpt-5-mini": { input_per_1k: 0.00025, output_per_1k: 0.002 },
    "gpt-5-nano": { input_per_1k: 0.00005, output_per_1k: 0.0004 },
    "gpt-5.1": { input_per_1k: 0.00125, output_per_1k: 0.01 },
    "gpt-5.2": { input_per_1k: 0.00175, output_per_1k: 0.014 },
    "gpt-5.4": { input_per_1k: 0.0025, output_per_1k: 0.015 },
    "gpt-5.4-mini": { input_per_1k: 0.00075, output_per_1k: 0.0045 },
    "gpt-5.4-nano": { input_per_1k: 0.0002, output_per_1k: 0.00125 },
    "gpt-5.5": { input_per_1k: 0.005, output_per_1k: 0.03 },
  },
  anthropic: {
    "claude-opus": { input_per_1k: 0.015, output_per_1k: 0.075 },
    "claude-sonnet": { input_per_1k: 0.003, output_per_1k: 0.015 },
    "claude-haiku": { input_per_1k: 0.0008, output_per_1k: 0.004 },
    // Real Anthropic model IDs (same 2026-09-19 snapshot caveats as above).
    // NOTE the generic "claude-opus" placeholder above is $15/$75, which is
    // the LEGACY Opus 4/4.1 rate - current Opus models (4.5 and later) are
    // $5/$25, hence the explicit per-model entries below rather than
    // relying on the family fallback in getRate().
    "claude-opus-5": { input_per_1k: 0.005, output_per_1k: 0.025 },
    "claude-opus-4-8": { input_per_1k: 0.005, output_per_1k: 0.025 },
    "claude-opus-4-7": { input_per_1k: 0.005, output_per_1k: 0.025 },
    "claude-opus-4-6": { input_per_1k: 0.005, output_per_1k: 0.025 },
    "claude-opus-4-5": { input_per_1k: 0.005, output_per_1k: 0.025 },
    "claude-opus-4-1": { input_per_1k: 0.015, output_per_1k: 0.075 },
    "claude-opus-4": { input_per_1k: 0.015, output_per_1k: 0.075 },
    "claude-3-opus": { input_per_1k: 0.015, output_per_1k: 0.075 },
    // Sonnet 5 had a time-limited introductory rate through 2026-08-31;
    // this is the standard rate that applies afterward. Sources still
    // disagree on which is current - verify against Anthropic's pricing page.
    "claude-sonnet-5": { input_per_1k: 0.003, output_per_1k: 0.015 },
    "claude-sonnet-4-6": { input_per_1k: 0.003, output_per_1k: 0.015 },
    "claude-sonnet-4-5": { input_per_1k: 0.003, output_per_1k: 0.015 },
    "claude-sonnet-4": { input_per_1k: 0.003, output_per_1k: 0.015 },
    "claude-3-7-sonnet": { input_per_1k: 0.003, output_per_1k: 0.015 },
    "claude-3-5-sonnet": { input_per_1k: 0.003, output_per_1k: 0.015 },
    "claude-haiku-4-5": { input_per_1k: 0.001, output_per_1k: 0.005 },
    "claude-3-5-haiku": { input_per_1k: 0.0008, output_per_1k: 0.004 },
    "claude-3-haiku": { input_per_1k: 0.00025, output_per_1k: 0.00125 },
    "claude-fable-5": { input_per_1k: 0.01, output_per_1k: 0.05 },
    "claude-fable-5-1": { input_per_1k: 0.01, output_per_1k: 0.05 },
  },
  bedrock: {
    "titan-text-express": { input_per_1k: 0.0002, output_per_1k: 0.0006 },
  },
};

// Per-tenant: in multi-tenant Guard each tenant sets its own overrides, so one
// tenant's negotiated rate must never price another tenant's traffic.
const overrideCaches = new Map(); // tenantKey -> { map, at }
const OVERRIDE_CACHE_MS = 30_000; // avoid hitting Guard's DB on every single request

async function getOverrideMap() {
  const key = tenantContext.tenantKey();
  const now = Date.now();
  const cached = overrideCaches.get(key);
  if (cached && now - cached.at < OVERRIDE_CACHE_MS) return cached.map;
  const rows = await guardDb.getPricingOverrides();
  const map = {};
  for (const r of rows) {
    map[`${String(r.provider).toLowerCase()}/${r.model}`] = {
      input_per_1k: r.input_per_1k,
      output_per_1k: r.output_per_1k,
    };
  }
  overrideCaches.set(key, { map, at: now });
  return map;
}

function clearOverrideCache() {
  overrideCaches.clear();
}

// Real provider model IDs rarely match a catalogue key byte-for-byte
// ("gpt-4o-2024-08-06", "claude-sonnet-4-5-20250929"): normalise first. Same
// rules, in the same order, as Guard's pricing.js so a dollar figure means the
// same thing in both products.
const { normalizeModelId } = require("./modelTiers");

function familyFallback(providerCatalogue, normalized) {
  let best = null;
  for (const key of Object.keys(providerCatalogue || {})) {
    if (normalized.startsWith(key + "-") && (!best || key.length > best.length)) best = key;
  }
  return best;
}

async function getRate(provider, model) {
  const p = String(provider || "").toLowerCase();
  const m = String(model || "");
  const normalized = normalizeModelId(m);

  // 1. Guard's manual override always wins (exact id first, then normalised).
  const overrides = await getOverrideMap();
  for (const candidate of m === normalized ? [m] : [m, normalized]) {
    const override = overrides[`${p}/${candidate}`];
    if (override) return { ...override, source: "guard-override", approximate: false };
  }

  // 2. Baseline catalogue - exact match on the normalised id.
  const catalogue = BASELINE_CATALOGUE[p];
  const baseline = catalogue?.[normalized] || catalogue?.[m];
  if (baseline) return { ...baseline, source: "baseline", approximate: false };

  // 3. Family fallback - a GUESS by construction, so flagged approximate.
  const family = familyFallback(catalogue, normalized);
  if (family) return { ...catalogue[family], source: "baseline-family", approximate: true, matched_family: family };

  return null;
}

async function computeCost({ provider, model, input_tokens = 0, output_tokens = 0 }) {
  const rate = await getRate(provider, model);
  if (!rate) return { cost_usd: null, rate_found: false };
  const cost = (input_tokens / 1000) * rate.input_per_1k + (output_tokens / 1000) * rate.output_per_1k;
  return { cost_usd: Math.round(cost * 1e6) / 1e6, rate_found: true, source: rate.source, approximate: Boolean(rate.approximate) };
}

module.exports = { getRate, computeCost, clearOverrideCache, BASELINE_CATALOGUE };
