// evaluation/index.js - combines the three evaluation signals (blueprint
// section 3.5: deterministic checks, LLM-as-judge, lexical similarity as
// a always-available zero-dependency baseline) into one persisted
// evaluation_results row, and aggregates results per (provider, primary,
// candidate) pair for recommend.js's confidence-state logic. Human labels
// (blueprint's acceptable/unacceptable/needs_review/etc.) are recorded
// separately via recordHumanLabel, against an existing result row.

const db = require("../storage");
const { tenantKey } = require("../tenantContext");
const { runDeterministicChecks, extractText } = require("./deterministic");
const { judgeResponses } = require("./llmJudge");
const { tokenize, termFrequency, cosineSimilarityLocal } = require("../semanticCache");

function lexicalSimilarity(textA, textB) {
  return cosineSimilarityLocal(termFrequency(tokenize(textA)), termFrequency(tokenize(textB)));
}

async function createEvaluationCase({ source, provider, primaryModel, candidateModel, inputJson, rubric, team, baselineResponse = null, triggerSource = null, guardFlagId = null }) {
  const result = await db.run(
    `INSERT INTO evaluation_cases (tenant_key, source, provider, primary_model, candidate_model, input_json, rubric, team, baseline_response, trigger_source, guard_flag_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    [tenantKey(), source, provider, primaryModel, candidateModel, JSON.stringify(inputJson), rubric ? JSON.stringify(rubric) : null, team || null, baselineResponse, triggerSource, guardFlagId]
  );
  return result.lastInsertRowid;
}

async function getEvaluationCase(id) {
  return db.get(`SELECT * FROM evaluation_cases WHERE id = ? AND tenant_key = ?`, [id, tenantKey()]);
}

async function listEvaluationCases({ limit = 100 } = {}) {
  return db.all(`SELECT id, created_at, source, provider, primary_model, candidate_model, team, trigger_source, guard_flag_id,
                        (baseline_response IS NOT NULL) AS has_baseline
                 FROM evaluation_cases WHERE tenant_key = ? ORDER BY id DESC LIMIT ?`, [tenantKey(), Math.min(500, Number(limit) || 100)]);
}

// Highest Guard flagged_test_cases id already imported for this tenant.
async function lastImportedGuardFlagId() {
  const row = await db.get(`SELECT COALESCE(MAX(guard_flag_id), 0) AS id FROM evaluation_cases WHERE tenant_key = ?`, [tenantKey()]);
  return Number(row?.id || 0);
}

// The main entry point: given a primary (current) response and a
// candidate (cheaper) response to the SAME input, score the candidate
// against every available signal and persist the result.
async function runEvaluation({
  caseId,
  provider,
  primaryModel,
  candidateModel,
  team,
  primaryResponseJson,
  candidateResponseJson,
  primaryCostUsd,
  candidateCostUsd,
  rubric,
  inputSummary,
}) {
  const primaryText = extractText(primaryResponseJson);
  const candidateText = extractText(candidateResponseJson);

  const deterministic = runDeterministicChecks(candidateResponseJson, rubric);
  const lexical = lexicalSimilarity(primaryText, candidateText);

  let judge = { score: null, rationale: "Judge skipped for this evaluation", model: null };
  try {
    judge = await judgeResponses({
      rubric: rubric ? JSON.stringify(rubric) : null,
      referenceAnswer: primaryText,
      candidateAnswer: candidateText,
      inputSummary: inputSummary || "(no input summary provided)",
    });
  } catch (err) {
    judge = { score: null, rationale: `Judge threw unexpectedly: ${err.message}`, model: null };
  }

  const result = await db.run(
    `INSERT INTO evaluation_results
       (tenant_key, case_id, provider, primary_model, candidate_model, team, primary_cost_usd, candidate_cost_usd,
        deterministic_pass, deterministic_details, judge_score, judge_rationale, judge_model,
        lexical_similarity, primary_length, candidate_length, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      tenantKey(),
      caseId || null,
      provider,
      primaryModel,
      candidateModel,
      team || null,
      primaryCostUsd ?? null,
      candidateCostUsd ?? null,
      deterministic.pass === null ? null : deterministic.pass ? 1 : 0,
      deterministic.details,
      judge.score,
      judge.rationale,
      judge.model,
      Math.round(lexical * 1000) / 1000,
      primaryText.length,
      candidateText.length,
      judge.error ? judge.rationale : null,
    ]
  );

  return {
    id: result.lastInsertRowid,
    deterministic,
    judge,
    lexical_similarity: Math.round(lexical * 1000) / 1000,
  };
}

async function recordHumanLabel(resultId, label) {
  const validLabels = ["acceptable", "unacceptable", "needs_review", "better", "worse", "unsafe", "incomplete"];
  if (!validLabels.includes(label)) {
    throw new Error(`Invalid human label '${label}'. Must be one of: ${validLabels.join(", ")}`);
  }
  const result = await db.run(`UPDATE evaluation_results SET human_label = ? WHERE id = ? AND tenant_key = ?`, [label, resultId, tenantKey()]);
  if (!result.changes) throw new Error(`Evaluation result ${resultId} not found`);
}

// Aggregated evidence for one (provider, primary, candidate) pair - this
// is what recommend.js reads to decide a confidence state. Deliberately
// returns raw counts/averages, not a verdict - recommend.js applies the
// blueprint's confidence-state thresholds on top of this.
async function getEvaluationStatsForPair(provider, primaryModel, candidateModel) {
  const results = await db.all(
    `SELECT * FROM evaluation_results WHERE tenant_key = ? AND provider = ? AND primary_model = ? AND candidate_model = ? ORDER BY id DESC LIMIT 500`,
    [tenantKey(), provider, primaryModel, candidateModel]
  );

  if (results.length === 0) {
    return { sample_count: 0, avg_judge_score: null, deterministic_pass_rate: null, avg_lexical_similarity: null, human_labels: {} };
  }

  const judged = results.filter((r) => r.judge_score !== null);
  const deterministicChecked = results.filter((r) => r.deterministic_pass !== null);
  const humanLabels = {};
  for (const r of results) {
    if (r.human_label) humanLabels[r.human_label] = (humanLabels[r.human_label] || 0) + 1;
  }

  return {
    sample_count: results.length,
    avg_judge_score: judged.length ? round3(judged.reduce((s, r) => s + r.judge_score, 0) / judged.length) : null,
    judged_sample_count: judged.length,
    deterministic_pass_rate: deterministicChecked.length
      ? round3(deterministicChecked.filter((r) => r.deterministic_pass === 1).length / deterministicChecked.length)
      : null,
    deterministic_checked_count: deterministicChecked.length,
    avg_lexical_similarity: round3(results.reduce((s, r) => s + (r.lexical_similarity || 0), 0) / results.length),
    human_labels: humanLabels,
    human_review_sample_count: Object.values(humanLabels).reduce((a, b) => a + b, 0),
  };
}

function round3(n) {
  return Math.round((Number(n) || 0) * 1000) / 1000;
}

module.exports = { getEvaluationCase, listEvaluationCases, lastImportedGuardFlagId, createEvaluationCase, runEvaluation, recordHumanLabel, getEvaluationStatsForPair, lexicalSimilarity };
