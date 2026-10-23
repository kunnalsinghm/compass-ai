// storage/schema.sqlite.js - Compass's OWN schema.
//
// Deliberately separate from Guard's schema/database file. Compass never
// writes to Guard's tables - usage_events stays the single source of truth
// for spend, owned entirely by Guard (see server/guardDb.js, which opens
// Guard's database read-only for historical analysis). Compass's own
// tables here hold things Guard has no concept of: persisted cache
// entries, routing decisions and policies, evaluation cases/results,
// recommendations with a real approval/rollout lifecycle, and a savings
// ledger. Two SQLite files, one writer each, both in WAL mode - safe for
// Compass to read Guard's file concurrently with Guard's own process
// writing to it.

const SCHEMA_SQL = `
-- ---------------------------------------------------------------------
-- Exact-match cache (persisted - unlike Guard's in-memory Map, this
-- survives restarts and is what actually backs "Compass AI" as a
-- sellable, measurable optimization system rather than a proxy header).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cache_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_key TEXT NOT NULL DEFAULT '',  -- '' = single-tenant; else Guard's tenant id
  cache_key TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  team TEXT,
  customer_id TEXT,
  response_json TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_per_hit_usd REAL NOT NULL DEFAULT 0,
  hit_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cache_expires ON cache_entries(expires_at);
CREATE INDEX IF NOT EXISTS idx_cache_scope ON cache_entries(provider, model);

-- ---------------------------------------------------------------------
-- Semantic (near-duplicate) cache. Same honest two-mode design as
-- Guard's semanticCache.js (local word-overlap vs. real embeddings), but
-- persisted, and scoped by system-prompt fingerprint + tool-definition
-- fingerprint + tenant, per the blueprint's "a semantically similar
-- question may require a different answer if context changed" warning.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS semantic_cache_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_key TEXT NOT NULL DEFAULT '',  -- '' = single-tenant; else Guard's tenant id
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  team TEXT,
  customer_id TEXT,
  system_fingerprint TEXT,
  tools_fingerprint TEXT,
  prompt_text TEXT NOT NULL,
  vector_type TEXT NOT NULL,     -- 'local' | 'embedding'
  vector_json TEXT NOT NULL,
  response_json TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_per_hit_usd REAL NOT NULL DEFAULT 0,
  hit_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_semantic_scope ON semantic_cache_entries(provider, model, system_fingerprint, tools_fingerprint);
CREATE INDEX IF NOT EXISTS idx_semantic_expires ON semantic_cache_entries(expires_at);

-- ---------------------------------------------------------------------
-- Routing policies: an APPROVED (current_model -> suggested_model) switch
-- at a given rollout percentage. Created automatically at 0% ("shadow
-- only") the moment a recommendation is generated; only a human approval
-- (see approvals table) advances rollout_pct or status. The proxy route
-- consults this table on every request to decide whether THIS particular
-- request should be routed to the cheaper model (see router.js).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS routing_policies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_key TEXT NOT NULL DEFAULT '',  -- '' = single-tenant; else Guard's tenant id
  scope_type TEXT NOT NULL DEFAULT 'global',  -- 'global' | 'team' | 'key'
  scope_value TEXT NOT NULL DEFAULT '',        -- '' = whole tenant (NULL would defeat the unique index)
  provider TEXT NOT NULL,
  from_model TEXT NOT NULL,
  to_model TEXT NOT NULL,
  rollout_pct INTEGER NOT NULL DEFAULT 0,     -- 0,1,5,25,50,100
  status TEXT NOT NULL DEFAULT 'shadow',      -- shadow|canary|limited|majority|full|rolled_back|rejected
  recommendation_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_routing_policy ON routing_policies(tenant_key, scope_type, scope_value, provider, from_model);

-- Explainable log of every routing decision the proxy made - this is what
-- lets Compass answer "why was this request routed to model X" the same
-- way the blueprint's model-allowlist explainability example does.
CREATE TABLE IF NOT EXISTS routing_decisions_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_key TEXT NOT NULL DEFAULT '',  -- '' = single-tenant; else Guard's tenant id
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
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

-- ---------------------------------------------------------------------
-- Evaluation layer: cases (inputs worth testing) and results (scored
-- comparisons of primary vs. candidate model output). Deterministic
-- checks, LLM-as-judge, lexical similarity, and human labels are all
-- columns on the same result row so recommend.js can combine them rather
-- than trusting any single signal - per the blueprint's explicit warning
-- that LLM judges "should not be treated as objective truth."
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS evaluation_cases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_key TEXT NOT NULL DEFAULT '',  -- '' = single-tenant; else Guard's tenant id
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  source TEXT NOT NULL,             -- 'shadow_test' | 'manual' | 'production_trigger'
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
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_key TEXT NOT NULL DEFAULT '',  -- '' = single-tenant; else Guard's tenant id
  case_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  provider TEXT NOT NULL,
  primary_model TEXT NOT NULL,
  candidate_model TEXT NOT NULL,
  team TEXT,
  primary_cost_usd REAL,
  candidate_cost_usd REAL,
  deterministic_pass INTEGER,        -- 1 | 0 | NULL (no deterministic checks configured)
  deterministic_details TEXT,
  judge_score REAL,                  -- 0-1, NULL if judge not configured/failed
  judge_rationale TEXT,
  judge_model TEXT,
  lexical_similarity REAL,           -- 0-1, always computed (zero-dependency fallback signal)
  human_label TEXT,                  -- acceptable|unacceptable|needs_review|better|worse|unsafe|incomplete
  primary_length INTEGER,
  candidate_length INTEGER,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_eval_pair ON evaluation_results(provider, primary_model, candidate_model);
CREATE INDEX IF NOT EXISTS idx_eval_time ON evaluation_results(created_at);

-- ---------------------------------------------------------------------
-- Recommendations: the customer-facing unit of "should I switch models."
-- confidence is one of the blueprint's explicit vocabulary values and
-- must never imply more certainty than evidence_json actually supports
-- (see recommend.js).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recommendations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_key TEXT NOT NULL DEFAULT '',  -- '' = single-tenant; else Guard's tenant id
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  provider TEXT NOT NULL,
  current_model TEXT NOT NULL,
  suggested_model TEXT NOT NULL,
  window_days INTEGER NOT NULL,
  current_cost_usd REAL,
  estimated_suggested_cost_usd REAL,
  estimated_savings_usd REAL,
  estimated_savings_pct REAL,
  affected_events INTEGER,
  confidence TEXT NOT NULL,
  caveat TEXT,
  evidence_json TEXT,
  status TEXT NOT NULL DEFAULT 'pending'   -- pending|approved|rejected|rolled_back
  );
CREATE UNIQUE INDEX IF NOT EXISTS uq_recommendation ON recommendations(tenant_key, provider, current_model, suggested_model);

CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_key TEXT NOT NULL DEFAULT '',  -- '' = single-tenant; else Guard's tenant id
  recommendation_id INTEGER NOT NULL,
  action TEXT NOT NULL,           -- approve|reject|advance_rollout|rollback
  actor TEXT NOT NULL,
  note TEXT,
  rollout_pct INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_approvals_rec ON approvals(recommendation_id);

-- ---------------------------------------------------------------------
-- Savings ledger: every dollar Compass claims credit for, itemized and
-- reversible to audit. net_savings_usd = gross - overhead, per the
-- blueprint's formula - never charge for a theoretical saving as if
-- realized.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS savings_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_key TEXT NOT NULL DEFAULT '',  -- '' = single-tenant; else Guard's tenant id
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  kind TEXT NOT NULL,             -- exact_cache_hit|semantic_cache_hit|routing_switch
  provider TEXT,
  model TEXT,
  team TEXT,
  customer_id TEXT,
  gross_savings_usd REAL NOT NULL,
  overhead_usd REAL NOT NULL DEFAULT 0,
  net_savings_usd REAL NOT NULL,
  reference_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_savings_time ON savings_ledger(created_at);
CREATE INDEX IF NOT EXISTS idx_savings_kind ON savings_ledger(kind);

-- Immutable-from-the-app's-perspective audit trail for admin actions
-- (approvals, rollouts, cache clears, policy edits) - same shape as
-- Guard's audit_log so the two feel like one product family.
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_key TEXT NOT NULL DEFAULT '',  -- '' = single-tenant; else Guard's tenant id
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  details TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
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
