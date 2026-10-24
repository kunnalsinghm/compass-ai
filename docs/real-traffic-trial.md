# Real-traffic trial

Everything automated so far ran against a mock provider. That proves the plumbing,
not the quality. This trial runs a short, capped set of real requests through
Compass and reports what happened.

## Before you start
- Guard and Compass running, with a Guard-issued API key.
- A real provider key (OpenAI or Anthropic). Use a key with a spend limit.
- Optional but recommended: set `COMPASS_JUDGE_API_KEY` on the Compass server so
  cheaper-model answers get an LLM quality score. Without it you only get word
  overlap, which cannot tell you whether an answer is right.

## Run it (PowerShell)
```
$env:COMPASS_URL="http://localhost:4100"
$env:COMPASS_API_KEY="fk_..."
$env:PROVIDER="openai"
$env:PROVIDER_KEY="sk-..."
$env:MODEL="gpt-4o"
$env:DRY_RUN="1"; node scripts/real-traffic-trial.js   # prints the plan, sends nothing
Remove-Item Env:DRY_RUN
node scripts/real-traffic-trial.js
```
Defaults: 10 prompts, 5 requests each (control, cache miss + hit, routed, shadow) = 50 requests, plus 10 background comparison calls through Guard. Hard cap `MAX_REQUESTS=60`. Typically
well under a dollar. Use `PROMPTS_FILE` to test your own representative prompts -
that is much more informative than the defaults.

## What it checks
| Check | What a failure means |
|---|---|
| All requests succeeded | Guard/Compass/provider wiring problem - read the error shown |
| Second identical request is a cache hit | Cache keying or opt-in header problem |
| Cache hits return the identical answer | Cache returned something different from what was stored |
| Cache hits cost nothing | Cost accounting bug |
| Every queued shadow test produced a result | Shadow pipeline problem (background call failed) |
| Routing downgraded some easy traffic | Informational: dial too low, or models not on the ladder |
| Routed pass cost less than control | Routing is not saving money on this traffic |
| Judge average >= 0.8 | Cheaper model answers are noticeably worse |
| Rubric (JSON fields) pass | Cheaper model breaks structured output |

## What it cannot check
- Whether the cheaper answers are good for **your** use case. Read the "worst
  answers" list the script prints, with your own eyes.
- Whether the dollar figures match your bill. Compare the claimed savings with the
  provider's usage page after the run.

## After the trial
- Open the dashboard: Evaluation Cases/Results should show the shadow tests.
- Only approve a rollout beyond the 5% canary once the recommendation shows 30+
  samples (the dashboard shows the progress).
