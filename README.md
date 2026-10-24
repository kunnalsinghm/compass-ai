# Compass AI

**FinOps Trinity - Product 2.** Cost reduction through caching,
interpretable model routing, and quality-verified optimization - sitting
in front of a running [Guard](../finops-mvp) deployment, never replacing
it.

Compass does not talk to OpenAI/Anthropic directly and does not maintain
its own spend ledger or user accounts. It reads Guard's usage/pricing/RBAC
data (read-only) and forwards traffic to Guard's own proxy for governance,
metering, and the real provider call. What Compass adds on top: a
persisted cache, an explainable router, a real evaluation layer (not just
word-overlap), a recommendation engine with a genuine approval/rollout
workflow, and a savings ledger that backs every dollar it claims credit
for with a row in a database.

## Stack

Node.js + Express, `node:sqlite` by default (Postgres optional) - the same
stack as Guard, on purpose: one operational mental model for both
products. No frontend build step; the dashboard is vanilla HTML/CSS/JS
sharing Guard's "metering console" design tokens (its own copy - see
`public/dashboard.css`'s header comment for why these are independently
deployable services rather than a shared package).

## Quick start

```bash
# 1. Have Guard running first (see ../finops-mvp) - seed it so there's
#    real spend history for Compass to work with:
cd ../finops-mvp && npm install && npm run seed && npm start &

# 2. Install and configure Compass
cd compass-ai
npm install
cp .env.example .env
# at minimum, confirm GUARD_DB_PATH points at Guard's actual data/finops.db

# 3. Seed Compass (pulls real recommendations from Guard's spend, plus
#    simulated evaluation history so the dashboard isn't empty)
npm run seed

# 4. Start Compass
npm start
# Dashboard: http://localhost:4100
# Proxy endpoint: http://localhost:4100/api/proxy/:provider
```

Point your application's OpenAI/Anthropic-compatible client at Compass
instead of Guard:

```js
const { CompassClient } = require("./sdk/compass-client");
const client = new CompassClient({
  baseUrl: "http://localhost:4100",
  apiKey: "fk_...",       // the same key Guard issued
  providerKey: "sk-...",  // your real provider key
  team: "growth",
});

const response = await client.chat("openai", {
  model: "gpt-4o",
  messages: [{ role: "user", content: "hello" }],
}, { cache: true, routing: true, costQualityDial: 6 });

console.log(response._compass); // { cache: 'miss', effectiveModel: 'gpt-4o-mini', savingsUsd: '0.0031', ... }
```

## Architecture

```
Client SDK
    |
    v
Compass proxy (POST /api/proxy/:provider)
    |
    +--> 1. Persisted cache lookup (exact, then semantic) -- hit short-circuits everything below
    |
    +--> 2. Interpretable router: classify + cost-quality dial + policy rollout sampling
    |
    +--> 3. Forward to GUARD's own proxy (governance, metering, the real provider call)
    |
    +--> 4. Cache the response, record routing savings, fire-and-forget shadow test
    |
    v
Response back to client (X-Compass-* headers explain every decision made)
```

Compass's own database (`server/storage/`) holds cache entries, routing
policies/decisions, evaluation cases/results, recommendations, approvals,
and the savings ledger. `server/guardDb.js` is a **read-only** window into
Guard's database for spend history, pricing overrides, and RBAC - Compass
never writes there, and Guard never reads Compass's tables. Two SQLite
files (or two Postgres databases/schemas), one writer each.

See each module's header comment for the reasoning behind its specific
design choices - `server/router.js`, `server/cache.js`,
`server/semanticCache.js`, `server/evaluation/`, `server/recommend.js`,
and `server/rollout.js` are the ones worth reading first.

## Features

### Caching - two independent, opt-in tiers

Same two-tier design as Guard's own proxy-level caching, but **persisted**
(survives restarts) and recorded to a real savings ledger instead of an
in-memory trick:

- **Exact-match** (`X-Compass-Cache: true`) - identical provider + model +
  message content + team/customer scope returns the cached response with
  zero calls to Guard or the provider.
- **Semantic** (`X-Compass-Semantic-Cache: true`) - near-duplicate prompts
  match via local term-frequency cosine similarity by default, or real
  embeddings if `COMPASS_EMBEDDING_API_KEY` is set. Scoped by
  system-prompt fingerprint and tool-definition fingerprint in addition to
  provider/model/tenant, per the explicit warning that a semantically
  similar question can require a different answer if the underlying
  context changed.

Neither tier is applied to streaming requests in this build - see
`server/routes/proxy.js`'s streaming branch.

### Interpretable routing

`X-Compass-Enable-Routing: true` turns on the classifier: every request is
tagged `easy` / `medium` / `hard-ish tiers` / `tool-heavy` / `long-context`
/ `safety-sensitive` with plain-English reasons (never a black-box score),
then combined with a 0-10 cost-quality dial
(`X-Compass-Cost-Quality-Dial`). Dial semantics:

| Dial | Behavior |
|---|---|
| 0-2 | Never downgrades |
| 3-4 | Downgrades only `easy` traffic |
| 5 | Downgrades `easy` and `medium` (balanced default) |
| 6-7 | Downgrades most tiers except long-context/tool-heavy |
| 8-10 | Downgrades everything except safety-sensitive/specialized |

`safety-sensitive` traffic is **never** auto-downgraded regardless of
dial. A team already at 80%+ of its Guard-defined monthly budget gets its
effective dial raised (never lowered) automatically. Every decision is
logged to `routing_decisions_log` and viewable via
`GET /api/router/decisions`.

An **approved recommendation** (see below) always takes precedence over
the dial - that's what makes a 5% canary or 50% rollout real: each request
is independently sampled against the policy's `rollout_pct`.

### Evaluation layer

Three signals, combined, never trusted individually (`server/evaluation/`):

- **Deterministic checks** (`deterministic.js`) - JSON schema validation,
  regex, required-fields. The most trustworthy signal, when a rubric is
  available.
- **LLM-as-judge** (`llmJudge.js`) - defaults to calling Claude, fully
  pluggable via `COMPASS_JUDGE_*` env vars. Degrades gracefully (not an
  error) when unconfigured.
- **Lexical similarity** - always computed, zero-dependency, the fallback
  signal when no judge is configured.

Human labels (`acceptable` / `unacceptable` / `needs_review` / `better` /
`worse` / `unsafe` / `incomplete`) can be attached to any evaluation result
via `POST /api/evaluation/results/:id/label` and take precedence over
automated scores in the confidence calculation.

### Shadow testing

`X-Compass-Enable-Shadow-Test: true` (plus a sample rate) sends a copy of
eligible **non-streaming** traffic to the cheaper same-provider
alternative, purely to gather evaluation evidence - the customer-visible
response is never affected. Fire-and-forget, so it adds zero latency to
the real request.

### Production trace-to-test-case pipeline

`POST /api/feedback` lets a calling application report a production event
worth making permanent (thumbs-down, tool error, customer correction,
etc. - see `server/tracePipeline.js` for the full trigger vocabulary).
Every reported event becomes a permanent, reusable evaluation case, and
(when a cheaper alternative exists) immediately queues a fresh shadow
test.

### Recommendation engine + approval/rollout workflow

`POST /api/recommendations/generate` pulls real spend from Guard and
combines it with accumulated evaluation evidence into a confidence state:
`cost-only` -> `insufficient-sample` -> `shadow-tested-similar` /
`shadow-tested-diverges` -> `human-reviewed`. A recommendation's
`confidence` (automated, evidence-based) and its `status`/`rollout_label`
(human workflow state) are deliberately separate fields - regenerating
recommendations never silently approves or un-approves anything.

Approving a recommendation (`POST /api/rollout/:id/approve`) creates a
live routing policy at whatever percentage you choose (0/1/5/25/50/100 -
shadow/canary/limited/majority/full). `POST /api/rollout/:id/advance` and
`.../rollback` move it along the ladder. `POST /api/rollout/auto-check`
(also runs on a schedule) re-scores every live policy against fresh
evaluation evidence and automatically rolls back anything that has
degraded to `shadow-tested-diverges` - independent of the recommendation
that created it, per the principle that a circuit breaker shouldn't depend
on the thing it's protecting against.

### Tiered economics report

`GET /api/savings/tiered-economics` shows the **same real traffic** under
three policies - all-premium, currently-approved routing (at its actual
live rollout percentage), and fully-aggressive - so the cost/quality
trade-off is visible rather than a bare savings percentage.

### Audit trail

Every approval, rejection, rollout change, and cache clear is logged to
`audit_log` (`GET /api/audit`), same shape as Guard's own.

## API reference

All endpoints require `X-API-Key` (validated against **Guard's** key
store - Compass issues no keys of its own). Guard's bootstrap mode
(no keys/users yet) is mirrored here too.

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/proxy/:provider` | The main endpoint - cache, route, forward to Guard |
| GET/POST | `/api/cache/stats`, `/api/cache/clear` | Exact-match cache |
| GET/POST | `/api/semantic-cache/stats`, `/api/semantic-cache/clear` | Semantic cache |
| GET | `/api/router/decisions` | Explainable routing decision log |
| POST | `/api/router/explain` | Dry-run classification, no side effects |
| GET | `/api/evaluation/results`, `/api/evaluation/stats` | Evaluation evidence |
| POST | `/api/evaluation/results/:id/label` | Attach a human label |
| GET | `/api/evaluation/cases` | Test cases (shadow tests, feedback, imported Guard flags) |
| POST | `/api/evaluation/sync-guard` | Import Guard's flagged test cases now (also runs on a schedule) |
| POST | `/api/evaluation/cases/:id/replay` | Replay a case against its candidate model (needs `X-Provider-Key`) |
| POST | `/api/feedback` | Report a production event -> permanent test case |
| GET/POST | `/api/recommendations`, `/api/recommendations/generate` | Recommendation engine |
| POST | `/api/rollout/:id/approve\|reject\|advance\|rollback` | Approval workflow |
| POST | `/api/rollout/auto-check` | Manually trigger the auto-rollback sweep |
| GET | `/api/savings/summary`, `/api/savings/tiered-economics` | Savings ledger + report |
| GET | `/api/savings/verified` | Overhead-adjusted realized savings and the fee they support |
| GET | `/api/savings/baseline` | Audit of the ledger against Guard's own before/after spend (corroboration, never billing) |
| GET | `/api/audit` | Audit log |
| GET | `/api/health` | Compass DB + Guard connectivity |

Every proxy request also accepts: `X-Compass-Cache`,
`X-Compass-Semantic-Cache`, `X-Compass-Cache-TTL-Seconds`,
`X-Compass-Enable-Routing`, `X-Compass-Cost-Quality-Dial`,
`X-Compass-Enable-Shadow-Test`, `X-Compass-Shadow-Test-Sample-Rate`,
`X-Compass-Rubric`, plus the same `X-Team` / `X-Customer-Id` /
`X-Environment` / `X-Git-Branch` / `X-Feature-Id` / `X-Client-Region`
headers Guard itself accepts (forwarded through unchanged). Guard's own
`X-Enable-Cache` / `X-Enable-Semantic-Cache` / `X-Enable-Shadow-Test`
headers are deliberately **not** forwarded - use Compass's `X-Compass-*`
equivalents when routing through Compass, to avoid two independent caching
layers disagreeing about what "cached" means.

## Guard integration and multi-tenancy

Compass sits in front of Guard and follows Guard's rules:

- **Identity**: the team bound to the API key wins; a conflicting `X-Team` is a 403. Attribution headers (project, cost centre, feature, agent, task, region...) are forwarded to Guard.
- **Governance before cache**: a cache hit never reaches Guard, so Compass mirrors Guard's model and region allow-lists (most-specific-wins) before serving one. Requests are PII-redacted *before* the cache key is built, so raw PII is never cached. `X-Disable-PII-Redaction: true` also disables caching and shadow tests.
- **Cache hits are visible in Guard**: reported as zero-token events carrying a `compass` payload (disable with `COMPASS_REPORT_CACHE_HITS=false`).
- **Streaming**: streamed responses are captured, cached, replayed as SSE, and shadow-tested.
- **Outage failover**: only on 500/502/503/504/529 from a non-streaming call, text-only requests, and only if the caller sends `X-Compass-Fallback-Provider-Key`. Policy refusals (402/403/429) are never retried elsewhere. The fallback still goes through Guard.
- **Multi-tenant**: with Guard on `FINOPS_MULTI_TENANT=true`, set `COMPASS_MULTI_TENANT=true` (Postgres required). Every Compass table carries `tenant_key`, the tenant context fails closed outside a request, and background jobs run once per active tenant. Give Compass a **read-only** Postgres role for Guard's database.
- **Rollout evidence gate**: up to a 5% canary is ungated; going wider needs `COMPASS_MIN_SAMPLES_FOR_WIDE_ROLLOUT` (30) evaluation samples and no "diverges" verdict, or `override: true` plus a note (recorded in the approval log).
- **Upgrading**: databases created before tenant scoping are migrated in place on start (`storage/legacyMigrate.js`), including de-duplicating routing policies.

## Verifying it on real traffic

The automated tests use a mock provider. Before relying on Compass, run the capped trial in
[docs/real-traffic-trial.md](docs/real-traffic-trial.md) (`scripts/real-traffic-trial.js`): it sends real requests through
cache, routing and shadow tests and reports pass/fail. The dashboard's **Savings Verification** panel then compares the ledger
with Guard's own spend before and after Compass started; it says "inconclusive" when the workload changed rather than guess.

## Configuration

See `.env.example` - every variable is documented there with its default.

## Deployment

**Bare metal / same host as Guard:** set `GUARD_DB_PATH` to Guard's actual
`data/finops.db` and start both processes normally. SQLite's WAL mode
(already enabled by Guard) supports Compass reading concurrently with
Guard's own writer process.

**Docker:** `docker compose up --build` bind-mounts Guard's data directory
read-only (set `GUARD_DATA_HOST_PATH` in `.env`) and points
`GUARD_BASE_URL` at wherever Guard itself is reachable. If Guard runs on
Postgres instead, `docker compose --profile postgres up --build` skips the
bind mount entirely and connects via `GUARD_POSTGRES_URL` - no shared
filesystem needed. See `docker-compose.yml`'s header comment for both
paths in detail.

## Bootstrap mode

Identical window to Guard's own: if Guard has no API keys or users yet,
Compass also serves requests as admin (so a first-time operator can
explore both dashboards before creating a key), and closes the instant
Guard gets its first key or user - both read the same table.

## What's tested vs. what needs your own verification

**Tested** (see `test/`, `npm test`): cache hit/miss/expiry/tenant
isolation, the interpretable router's classifier/dial/allowlist/policy
precedence logic, deterministic evaluation checks (schema/regex/required
fields), the recommendation engine's confidence-state thresholds, and the
full approve -> advance -> rollback -> auto-rollback state machine. All
run against a real fixture Guard-shaped SQLite database, not mocks of
`guardDb.js` itself.

**Needs your own verification before relying on it in production:**

- **Postgres backend** - exercised once end to end (two Guard tenants, cache isolation, per-tenant savings and Guard events) but not under load, and the legacy-migration path is only unit-tested on SQLite.
- **Real embedding-mode semantic caching** - the local term-frequency mode
  is what's tested; the OpenAI-embeddings path is straightforward but
  untested against a live embeddings endpoint in this environment.
- **LLM-judge scoring under real production load** - the judge call itself
  is tested for graceful degradation (missing key, malformed response),
  but its actual scoring quality on your specific traffic is something
  only your own evaluation data can tell you.
- **Streaming passthrough end-to-end through a real provider** - verified
  the proxy/pipe mechanics; a full SSE round-trip against a live
  OpenAI/Anthropic account wasn't part of this build's test loop.

## Known gaps (deliberately out of scope for this build)

- **Learned routing** - only the interpretable classifier is built.
  Learned-router mode needs a volume of customer-specific evaluation data
  this build has no way to have accumulated yet.
- **Production-signal detection** - Guard's flagged test cases (thumbs-down, high retry, low shadow similarity) are imported; latency regressions and other signals are not inferred. `POST /api/feedback` remains for explicit reports.
- **Evaluation depth** - no pairwise judge or trajectory/tool-call-validity checks yet.
- **Savings baseline verification** - savings are ledgered per event; a before/after baseline-window verification is not built.
- **Tool-call execution/sandboxing during shadow tests** - not applicable
  at this layer; Compass only re-runs the model call, never executes a
  tool on the caller's behalf (see `shadowTest.js`'s header comment).

## License

MIT
