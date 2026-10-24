#!/usr/bin/env node
// scripts/real-traffic-trial.js - a short, capped trial of Compass against REAL
// provider traffic, with a pass/fail report at the end.
//
// Why it exists: the test suite and the local mock provider prove the plumbing.
// They cannot tell you whether cheaper-model answers are actually good enough,
// whether the cache returns sensible answers, or whether the cost numbers match
// your provider bill. Only real calls can. This sends a small, varied set of
// prompts through Compass in four passes and checks what came back.
//
// Usage (zero dependencies, Node 18+):
//   COMPASS_URL=http://localhost:4100 COMPASS_API_KEY=fk_... \
//   PROVIDER=openai PROVIDER_KEY=sk-... MODEL=gpt-4o \
//   node scripts/real-traffic-trial.js
//
// Optional: PROMPTS_FILE=prompts.json (array of strings or {prompt, rubric}),
//           MAX_REQUESTS=60 (hard cap), TEAM=..., DIAL=0-10 (default 7),
//           JUDGE: set COMPASS_JUDGE_API_KEY on the Compass server for quality scores,
//           DRY_RUN=1 to print the plan and the worst-case request count only.
//
// It spends real money: a few dozen short requests, usually well under a dollar
// on gpt-4o / claude-sonnet class models. MAX_REQUESTS is a hard stop.

const URL_BASE = (process.env.COMPASS_URL || "http://localhost:4100").replace(/\/$/, "");
const API_KEY = process.env.COMPASS_API_KEY || "";
const PROVIDER = (process.env.PROVIDER || "openai").toLowerCase();
const PROVIDER_KEY = process.env.PROVIDER_KEY || "";
const MODEL = process.env.MODEL || (PROVIDER === "anthropic" ? "claude-sonnet-4-5" : "gpt-4o");
const MAX_REQUESTS = Number(process.env.MAX_REQUESTS) || 60;
const DIAL = process.env.DIAL || "7";
const TEAM = process.env.TEAM || "";

const DEFAULT_PROMPTS = [
  { prompt: "What is the capital of Australia? Answer in one word." },
  { prompt: "Convert 72 degrees Fahrenheit to Celsius. Give just the number." },
  { prompt: "Summarize in one sentence: Caching stores the result of an expensive computation so repeated requests can reuse it instead of recomputing." },
  { prompt: "Fix the grammar: 'Their going to the store tomorrow, and me and him is bringing snacks.'" },
  { prompt: "Classify the sentiment (positive/negative/neutral): 'The delivery was late but the support team fixed it quickly.'" },
  { prompt: 'Return ONLY valid JSON with keys "name" and "age" for: Maria is 34 years old.', rubric: { type: "required_fields", fields: ["name", "age"] } },
  { prompt: "Write a SQL query that returns the top 3 customers by total order value from tables customers(id,name) and orders(id,customer_id,total)." },
  { prompt: "Explain in three bullet points why a retry with exponential backoff is better than immediate retries." },
  { prompt: "A train leaves at 14:20 and arrives at 17:05. How long is the trip? Show the arithmetic briefly." },
  { prompt: "Rewrite politely: 'Send me the report now, you are late again.'" },
];

function loadPrompts() {
  if (!process.env.PROMPTS_FILE) return DEFAULT_PROMPTS;
  const raw = JSON.parse(require("fs").readFileSync(process.env.PROMPTS_FILE, "utf8"));
  return raw.map((p) => (typeof p === "string" ? { prompt: p } : p));
}

let sent = 0;
const results = [];

function bodyFor(prompt, model) {
  return PROVIDER === "anthropic"
    ? { model, max_tokens: 300, messages: [{ role: "user", content: prompt }] }
    : { model, max_tokens: 300, messages: [{ role: "user", content: prompt }] };
}
function textOf(json) {
  if (PROVIDER === "anthropic") return (json?.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  return json?.choices?.[0]?.message?.content || "";
}

async function call(pass, item, extraHeaders = {}) {
  if (sent >= MAX_REQUESTS) throw new Error(`MAX_REQUESTS (${MAX_REQUESTS}) reached`);
  sent++;
  const started = Date.now();
  const res = await fetch(`${URL_BASE}/api/proxy/${PROVIDER}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": API_KEY,
      "X-Provider-Key": PROVIDER_KEY,
      ...(TEAM ? { "X-Team": TEAM } : {}),
      "X-Environment": "compass-trial",
      ...extraHeaders,
    },
    body: JSON.stringify(bodyFor(item.prompt, MODEL)),
  });
  const json = await res.json().catch(() => ({}));
  const h = (n) => res.headers.get(n);
  const r = {
    pass,
    prompt: item.prompt,
    status: res.status,
    ms: Date.now() - started,
    text: res.ok ? textOf(json) : "",
    error: res.ok ? null : json.error || JSON.stringify(json).slice(0, 200),
    cache: h("x-compass-cache"),
    effectiveModel: h("x-compass-route-effective-model"),
    requestedModel: h("x-compass-route-requested-model"),
    costUsd: Number(h("x-compass-cost-usd")),
    savingsUsd: Number(h("x-compass-savings-usd")),
    shadow: h("x-compass-shadow-test"),
  };
  results.push(r);
  return r;
}

async function get(path) {
  const res = await fetch(`${URL_BASE}${path}`, { headers: { "X-API-Key": API_KEY } });
  return res.json().catch(() => null);
}

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok, detail });
  console.log(`${ok === true ? "PASS" : ok === false ? "FAIL" : "NOTE"}  ${name}${detail ? ` - ${detail}` : ""}`);
}
const usd = (n) => (Number.isFinite(n) ? `$${n.toFixed(5)}` : "n/a");

(async () => {
  const prompts = loadPrompts();
  const planned = prompts.length * 5; // control 1 + cache 2 + routed 1 + shadow 1
  console.log(`Compass real-traffic trial: ${PROVIDER}/${MODEL} via ${URL_BASE}`);
  console.log(`Plan: ${prompts.length} prompts, 5 requests each (control, cache miss+hit, routed, shadow) = up to ${planned} requests (cap ${MAX_REQUESTS}).`);
  if (process.env.DRY_RUN) return console.log("DRY_RUN set - nothing sent.");
  if (!API_KEY || !PROVIDER_KEY) {
    console.error("Set COMPASS_API_KEY (a Guard-issued key) and PROVIDER_KEY (your OpenAI/Anthropic key).");
    process.exit(2);
  }
  const health = await get("/api/health");
  if (!health?.ok) {
    console.error("Compass /api/health is not ok - is Compass (and Guard) running?", health);
    process.exit(2);
  }

  // Pass 1 - plain pass-through: the control. Everything off.
  console.log("\nPass 1/4: pass-through (features off) - the control");
  for (const p of prompts) await call("control", p);

  // Pass 2 - exact cache: the second identical call must be a hit with identical text.
  console.log("Pass 2/4: exact cache (miss, then hit)");
  for (const p of prompts) {
    await call("cache-miss", p, { "X-Compass-Cache": "true" });
    await call("cache-hit", p, { "X-Compass-Cache": "true" });
  }
  // (counts 2 requests per prompt; the cap protects against runaway)

  // Pass 3 - routing: cheaper model chosen where the dial allows it.
  console.log("Pass 3/4: routing");
  for (const p of prompts) {
    await call("routed", p, { "X-Compass-Enable-Routing": "true", "X-Compass-Cost-Quality-Dial": String(DIAL) });
  }

  // Pass 4 - shadow tests: the requested model answers the caller, and a copy goes to the
  // cheaper candidate in the background so the two answers can be compared. Routing is OFF
  // here on purpose: a request already routed to the cheap model has no cheaper candidate
  // to test, so shadow evidence has to come from traffic that still ran on the full model.
  console.log("Pass 4/4: shadow tests (routing off), then waiting for the background comparisons");
  for (const p of prompts) {
    await call("shadow", p, {
      "X-Compass-Enable-Shadow-Test": "true",
      "X-Compass-Shadow-Test-Sample-Rate": "1",
      ...(p.rubric ? { "X-Compass-Rubric": JSON.stringify(p.rubric) } : {}),
    });
  }
  await new Promise((r) => setTimeout(r, 20000));

  // ---------------------------------------------------------------- report
  console.log("\n=== Results ===");
  const by = (pass) => results.filter((r) => r.pass === pass);
  const failed = results.filter((r) => r.status !== 200);
  check("All requests succeeded", failed.length === 0, failed.length ? `${failed.length} failed, first: ${failed[0].status} ${failed[0].error}` : `${results.length} requests`);

  const hits = by("cache-hit");
  const hitOk = hits.filter((r) => r.cache === "hit");
  check("Second identical request is a cache hit", hitOk.length === hits.length, `${hitOk.length}/${hits.length}`);
  const sameText = hits.filter((r, i) => r.text && r.text === by("cache-miss")[i]?.text);
  check("Cache hits return the identical answer", sameText.length === hits.length, `${sameText.length}/${hits.length}`);
  const hitCost = hits.reduce((s, r) => s + (r.costUsd || 0), 0);
  check("Cache hits cost nothing", hitCost === 0, `total ${usd(hitCost)}`);

  const routed = by("routed");
  const downgraded = routed.filter((r) => r.effectiveModel && r.requestedModel && r.effectiveModel !== r.requestedModel);
  check("Routing downgraded some easy traffic", downgraded.length > 0 ? true : null, `${downgraded.length}/${routed.length} switched to a cheaper model`);
  const controlCost = by("control").reduce((s, r) => s + (r.costUsd || 0), 0);
  const routedCost = routed.reduce((s, r) => s + (r.costUsd || 0), 0);
  check("Routed pass cost less than the control pass", routedCost <= controlCost, `${usd(routedCost)} vs ${usd(controlCost)}`);
  const claimed = routed.reduce((s, r) => s + (r.savingsUsd || 0), 0);
  console.log(`NOTE  Savings Compass claims on the routed pass: ${usd(claimed)} (control - routed = ${usd(controlCost - routedCost)}). Compare both with your provider's usage page.`);

  const evalRes = (await get("/api/evaluation/results?limit=100")) || [];
  const shadowed = by("shadow").filter((r) => r.shadow === "queued");
  const mine = Array.isArray(evalRes) ? evalRes.slice(0, shadowed.length) : [];
  const lex = mine.filter((r) => r.lexical_similarity !== null && r.lexical_similarity !== undefined);
  const avgLex = lex.length ? lex.reduce((s, r) => s + r.lexical_similarity, 0) / lex.length : null;
  check("Every queued shadow test produced an evaluation result", shadowed.length > 0 && mine.length >= shadowed.length, `${mine.length} results for ${shadowed.length} queued`);
  if (avgLex !== null) console.log(`NOTE  Average lexical similarity primary vs candidate: ${avgLex.toFixed(2)} (word overlap only - low values on open-ended prompts are normal)`);
  const judged = mine.filter((r) => r.judge_score !== null && r.judge_score !== undefined);
  if (judged.length) {
    const avgJudge = judged.reduce((s, r) => s + r.judge_score, 0) / judged.length;
    check("LLM judge rates cheaper answers as good enough", avgJudge >= 0.8, `average ${avgJudge.toFixed(2)} over ${judged.length}`);
  } else {
    console.log("NOTE  No LLM-judge scores. Set COMPASS_JUDGE_API_KEY on the Compass server to get real quality scores - word overlap alone cannot tell you if an answer is right.");
  }
  const rubricFails = mine.filter((r) => r.deterministic_pass === 0 || r.deterministic_pass === false);
  check("Rubric checks (JSON fields) pass on the cheaper model", rubricFails.length === 0, `${rubricFails.length} failed`);

  const base = await get("/api/savings/baseline?days=7");
  if (base) console.log(`NOTE  Baseline verification status: ${base.status}${base.caveats?.[0] ? ` (${base.caveats[0]})` : ""} - needs history from before Compass to say more.`);

  console.log("\nWorst answers to read yourself (largest cost saved, shortest similarity first):");
  for (const r of downgraded.slice(0, 5)) console.log(`  - [${r.requestedModel} -> ${r.effectiveModel}] ${r.prompt.slice(0, 70)}\n      got: ${r.text.replace(/\s+/g, " ").slice(0, 140)}`);

  const hardFails = checks.filter((c) => c.ok === false);
  console.log(`\n${hardFails.length ? `${hardFails.length} check(s) FAILED - do not roll out until understood.` : "No hard failures."} Requests sent: ${sent}.`);
  console.log("Now read the routed answers above with your own eyes: that is the quality check no script can do for you.");
  process.exit(hardFails.length ? 1 : 0);
})().catch((err) => {
  console.error("Trial aborted:", err.message);
  process.exit(2);
});
