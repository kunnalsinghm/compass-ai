// evaluation/llmJudge.js - LLM-as-judge scoring for open-ended responses
// that deterministic.js can't check mechanically. Blueprint section 3.5
// is explicit that judge scores "should not be treated as objective
// truth" and must be combined with deterministic checks, human samples,
// and business metrics - see evaluation/index.js, which does exactly
// that combination, and recommend.js, which requires more than a judge
// score alone before raising confidence past "shadow-tested."
//
// Defaults to calling Claude (api.anthropic.com) as the judge model,
// since it's a reasonable, capable default - but this is fully pluggable:
// set COMPASS_JUDGE_BASE_URL / COMPASS_JUDGE_API_KEY / COMPASS_JUDGE_MODEL
// to point at any Anthropic-compatible Messages endpoint instead
// (including a self-hosted one, or a different vendor's compatible API).
//
// If no judge API key is configured, judgeResponses() returns
// { score: null, rationale: "..." } rather than throwing - shadow tests
// and recommendations must keep working with deterministic + lexical
// signals alone when no judge is wired up.

const BASE_URL = process.env.COMPASS_JUDGE_BASE_URL || "https://api.anthropic.com/v1/messages";
const API_KEY = process.env.COMPASS_JUDGE_API_KEY || null;
const MODEL = process.env.COMPASS_JUDGE_MODEL || "claude-sonnet-4-6";
const ANTHROPIC_VERSION = process.env.COMPASS_JUDGE_ANTHROPIC_VERSION || "2023-06-01";

function buildJudgePrompt({ rubric, referenceAnswer, candidateAnswer, inputSummary }) {
  return [
    "You are a strict evaluation judge comparing a candidate AI response against expectations.",
    "Score how well the candidate response would satisfy the same user as the reference/expected behavior.",
    "",
    `Task the AI was given: ${inputSummary}`,
    "",
    rubric ? `Evaluation rubric: ${rubric}` : "No specific rubric provided - judge general quality, correctness, and completeness.",
    "",
    referenceAnswer ? `Reference (baseline) response:\n${referenceAnswer}` : "(No reference response provided - judge the candidate on its own merits.)",
    "",
    `Candidate response:\n${candidateAnswer}`,
    "",
    "Respond with ONLY a JSON object, no other text, in this exact shape:",
    '{"score": <number 0.0-1.0>, "rationale": "<one or two sentences>"}',
  ].join("\n");
}

function parseJudgeJson(text) {
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed.score === "number") return parsed;
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]);
        if (typeof parsed.score === "number") return parsed;
      } catch {
        // fall through to null below
      }
    }
  }
  return null;
}

async function judgeResponses({ rubric, referenceAnswer, candidateAnswer, inputSummary }) {
  if (!API_KEY) {
    return { score: null, rationale: "No judge configured (COMPASS_JUDGE_API_KEY unset) - deterministic/lexical signals only", model: null };
  }

  const prompt = buildJudgePrompt({ rubric, referenceAnswer, candidateAnswer, inputSummary });

  try {
    const res = await fetch(BASE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": API_KEY,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 300,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      return { score: null, rationale: `Judge call failed: HTTP ${res.status} ${bodyText.slice(0, 200)}`, model: MODEL, error: true };
    }

    const json = await res.json();
    const text = (json?.content || []).filter((b) => b?.type === "text").map((b) => b.text).join("\n");
    const parsed = parseJudgeJson(text);

    if (!parsed) {
      return { score: null, rationale: "Judge response was not parseable as the requested JSON shape", model: MODEL, error: true };
    }

    return {
      score: Math.min(1, Math.max(0, parsed.score)),
      rationale: String(parsed.rationale || "").slice(0, 500),
      model: MODEL,
    };
  } catch (err) {
    return { score: null, rationale: `Judge call errored: ${err.message}`, model: MODEL, error: true };
  }
}

module.exports = { judgeResponses, isConfigured: () => Boolean(API_KEY) };
