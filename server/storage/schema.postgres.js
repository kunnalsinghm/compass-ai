// storage/schema.postgres.js - Postgres dialect of schema.sqlite.js. Kept
// visibly alongside it so the two can't silently drift apart - see that
// file's header comment for the reasoning behind every table.

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS cache_entries (
  id SERIAL PRIMARY KEY,
  tenant_key TEXT NOT NULL DEFAULT '',  -- '' = single-tenant; else Guard's tenant id
  cache_key TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  team TEXT,
  customer_id TEXT,
  response_json TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_per_hit_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
  hit_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cache_expires ON cache_entries(expires_at);
CREATE INDEX IF NOT EXISTS idx_cache_scope ON cache_entries(provider, model);

CREATE TABLE IF NOT EXISTS semantic_cache_entries (
  id SERIAL PRIMARY KEY,
  tenant_key TEXT NOT NULL DEFAULT '',  -- '' = single-tenant; else Guard's tenant id
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  team TEXT,
  customer_id TEXT,
  system_fingerprint TEXT,
  tools_fingerprint TEXT,
  prompt_text TEXT NOT NULL,
  vector_type TEXT NOT NULL,
  vector_json TEXT NOT NULL,
  response_json TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_per_hit_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
  hit_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_semantic_scope ON semantic_cache_entries(provider, model, system_fingerprint, tools_fingerprint);
CREATE INDEX IF NOT EXISTS idx_semantic_expires ON semantic_cache_entries(expires_at);

CREATE TABLE IF NOT EXISTS routing_policies (
  id SERIAL PRIMARY KEY,
  tenant_key TEXT NOT NULL DEFAULT '',  -- '' = single-tenant; else Guard's tenant id
  scope_type TEXT NOT NULL DEFAULT 'global',
  scope_value TEXT NOT NULL DEFAULT '',        -- '' = whole tenant (NULL would defeat the unique index)
  provider TEXT NOT NULL,
  from_model TEXT NOT NULL,
  to_model TEXT NOT NULL,
  rollout_pct INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'shadow',
  recommendation_id INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_routing_policy ON routing_policies(tenant_key, scope_type, scope_value, provider, from_model);

CREATE TABLE IF NOT EXISTS routing_decisions_log (
  id SERIAL PRIMARY KEY,
  tenant_key TEXT NOT NULL DEFAULT '',  -- '' = single-tenant; else Guard's tenant id
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  provider TEXT NOT NULL,
  requested_model TEXT NOT NULL,
  effective_model TEXT NOT NULL,
  classification TEXT,
  cost_quality_dial INTEGER,
  policy_id INTEGER,
  reasons_json TEXT NOT NULL,
  team TEXT,
  customer_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_routing_log_time ON routing_decisions_log(created_at);

CREATE TABLE IF NOT EXISTS evaluation_cases (
  id SERIAL PRIMARY KEY,
  tenant_key TEXT NOT NULL DEFAULT '',  -- '' = single-tenant; else Guard's tenant id
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source TEXT NOT NULL,
  provider TEXT NOT NULL,
  primary_model TEXT NOT NULL,
  candidate_model TEXT NOT NULL,
  input_json TEXT NOT NULL,
  rubric TEXT,
  team TEXT,
  baseline_response TEXT,           -- the answer the current model gave (replay compares against it)
  trigger_source TEXT,             -- why this became a permanent case (thumbs_down, high_retry_count, ...)
  guard_flag_id INTEGER            -- Guard flagged_test_cases.id this was imported from (dedupe key)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_evalcase_guard ON evaluation_cases(tenant_key, guard_flag_id);

CREATE TABLE IF NOT EXISTS evaluation_results (
  id SERIAL PRIMARY KEY,
  tenant_key TEXT NOT NULL DEFAULT '',  -- '' = single-tenant; else Guard's tenant id
  case_id INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  provider TEXT NOT NULL,
  primary_model TEXT NOT NULL,
  candidate_model TEXT NOT NULL,
  team TEXT,
  primary_cost_usd DOUBLE PRECISION,
  candidate_cost_usd DOUBLE PRECISION,
  deterministic_pass INTEGER,
  deterministic_details TEXT,
  judge_score DOUBLE PRECISION,
  judge_rationale TEXT,
  judge_model TEXT,
  lexical_similarity DOUBLE PRECISION,
  human_label TEXT,
  primary_length INTEGER,
  candidate_length INTEGER,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_eval_pair ON evaluation_results(provider, primary_model, candidate_model);
CREATE INDEX IF NOT EXISTS idx_eval_time ON evaluation_results(created_at);

CREATE TABLE IF NOT EXISTS recommendations (
  id SERIAL PRIMARY KEY,
  tenant_key TEXT NOT NULL DEFAULT '',  -- '' = single-tenant; else Guard's tenant id
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  provider TEXT NOT NULL,
  current_model TEXT NOT NULL,
  suggested_model TEXT NOT NULL,
  window_days INTEGER NOT NULL,
  current_cost_usd DOUBLE PRECISION,
  estimated_suggested_cost_usd DOUBLE PRECISION,
  estimated_savings_usd DOUBLE PRECISION,
  estimated_savings_pct DOUBLE PRECISION,
  affected_events INTEGER,
  confidence TEXT NOT NULL,
  caveat TEXT,
  evidence_json TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_recommendation ON recommendations(tenant_key, provider, current_model, suggested_model);

CREATE TABLE IF NOT EXISTS approvals (
  id SERIAL PRIMARY KEY,
  tenant_key TEXT NOT NULL DEFAULT '',  -- '' = single-tenant; else Guard's tenant id
  recommendation_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  note TEXT,
  rollout_pct INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_approvals_rec ON approvals(recommendation_id);

CREATE TABLE IF NOT EXISTS savings_ledger (
  id SERIAL PRIMARY KEY,
  tenant_key TEXT NOT NULL DEFAULT '',  -- '' = single-tenant; else Guard's tenant id
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  kind TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  team TEXT,
  customer_id TEXT,
  gross_savings_usd DOUBLE PRECISION NOT NULL,
  overhead_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
  net_savings_usd DOUBLE PRECISION NOT NULL,
  reference_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_savings_time ON savings_ledger(created_at);
CREATE INDEX IF NOT EXISTS idx_savings_kind ON savings_ledger(kind);

CREATE TABLE IF NOT EXISTS audit_log (
  id SERIAL PRIMARY KEY,
  tenant_key TEXT NOT NULL DEFAULT '',  -- '' = single-tenant; else Guard's tenant id
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  details TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cache_tenant ON cache_entries(tenant_key);
CREATE INDEX IF NOT EXISTS idx_semantic_tenant ON semantic_cache_entries(tenant_key);
CREATE INDEX IF NOT EXISTS idx_policy_tenant ON routing_policies(tenant_key);
CREATE INDEX IF NOT EXISTS idx_routing_log_tenant ON routing_decisions_log(tenant_key);
CREATE INDEX IF NOT EXISTS idx_evalcase_tenant ON evaluation_cases(tenant_key);
CREATE INDEX IF NOT EXISTS idx_evalresult_tenant ON evaluation_results(tenant_key, provider, primary_model, candidate_model);
CREATE INDEX IF NOT EXISTS idx_rec_tenant ON recommendations(tenant_key);
CREATE INDEX IF NOT EXISTS idx_approvals_tenant ON approvals(tenant_key);
CREATE INDEX IF NOT EXISTS idx_savings_tenant ON savings_ledger(tenant_key, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_tenant ON audit_log(tenant_key);
`;

module.exports = { SCHEMA_SQL };
