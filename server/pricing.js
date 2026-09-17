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

const BASELINE_CATALOGUE = {
  openai: {
    "gpt-4o": { input_per_1k: 0.0025, output_per_1k: 0.01 },
    "gpt-4o-mini": { input_per_1k: 0.00015, output_per_1k: 0.0006 },
  },
  anthropic: {
    "claude-opus": { input_per_1k: 0.015, output_per_1k: 0.075 },
    "claude-sonnet": { input_per_1k: 0.003, output_per_1k: 0.015 },
    "claude-haiku": { input_per_1k: 0.0008, output_per_1k: 0.004 },
  },
  bedrock: {
    "titan-text-express": { input_per_1k: 0.0002, output_per_1k: 0.0006 },
  },
};

let overrideCache = null;
let overrideCacheAt = 0;
const OVERRIDE_CACHE_MS = 30_000; // avoid hitting Guard's DB on every single request

async function getOverrideMap() {
  const now = Date.now();
  if (overrideCache && now - overrideCacheAt < OVERRIDE_CACHE_MS) return overrideCache;
  const rows = await guardDb.getPricingOverrides();
  const map = {};
  for (const r of rows) {
    map[`${String(r.provider).toLowerCase()}/${r.model}`] = {
      input_per_1k: r.input_per_1k,
      output_per_1k: r.output_per_1k,
    };
  }
  overrideCache = map;
  overrideCacheAt = now;
  return map;
}

async function getRate(provider, model) {
  const p = String(provider || "").toLowerCase();
  const m = String(model || "");

  const overrides = await getOverrideMap();
  const override = overrides[`${p}/${m}`];
  if (override) return { ...override, source: "guard-override" };

  const baseline = BASELINE_CATALOGUE[p]?.[m];
  if (baseline) return { ...baseline, source: "baseline" };

  return null;
}

async function computeCost({ provider, model, input_tokens = 0, output_tokens = 0 }) {
  const rate = await getRate(provider, model);
  if (!rate) return { cost_usd: null, rate_found: false };
  const cost = (input_tokens / 1000) * rate.input_per_1k + (output_tokens / 1000) * rate.output_per_1k;
  return { cost_usd: Math.round(cost * 1e6) / 1e6, rate_found: true, source: rate.source };
}

module.exports = { getRate, computeCost, BASELINE_CATALOGUE };
