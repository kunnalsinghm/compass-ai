// evaluation/deterministic.js - deterministic checks: JSON schema
// validation, regex, required-fields. Blueprint section 3.5 lists these
// first because they're the most trustworthy signal available - no
// judge-model bias, no sampling noise. This build covers the checks that
// make sense without executing arbitrary customer code (no code
// compilation / unit-test running here - that would mean executing
// untrusted output, which is explicitly out of scope for a shared
// evaluation service).
//
// A rubric is a small JSON object attached to an evaluation_case:
//   { "type": "json_schema", "schema": { required: [...], properties: {...} } }
//   { "type": "regex", "pattern": "^\\{.*\\}$", "flags": "s" }
//   { "type": "required_fields", "fields": ["ticket_id", "priority"] }
//   { "type": "none" }  (or rubric omitted entirely)
//
// Returns { pass: true|false|null, details: string }. null means "no
// deterministic rubric configured for this case" - NOT "failed check" -
// recommend.js must treat that as missing evidence, not negative evidence.

function extractText(responseJson) {
  // OpenAI shape
  const openaiText = responseJson?.choices?.[0]?.message?.content;
  if (typeof openaiText === "string") return openaiText;
  // Anthropic shape
  const anthropicBlocks = responseJson?.content;
  if (Array.isArray(anthropicBlocks)) {
    return anthropicBlocks
      .filter((b) => b?.type === "text")
      .map((b) => b.text)
      .join("\n");
  }
  return "";
}

function tryParseJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    // Some models wrap JSON in a fenced code block - one common,
    // deliberately narrow recovery attempt before giving up.
    const match = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (match) {
      try {
        return { ok: true, value: JSON.parse(match[1]) };
      } catch {
        return { ok: false, value: null };
      }
    }
    return { ok: false, value: null };
  }
}

function checkRequiredFields(obj, fields) {
  const missing = fields.filter((f) => obj == null || obj[f] === undefined || obj[f] === null);
  return { pass: missing.length === 0, missing };
}

function checkJsonSchema(obj, schema) {
  if (obj === null || typeof obj !== "object") return { pass: false, reason: "not a JSON object" };
  const required = Array.isArray(schema?.required) ? schema.required : [];
  const missing = required.filter((f) => obj[f] === undefined);
  if (missing.length) return { pass: false, reason: `missing required fields: ${missing.join(", ")}` };

  const properties = schema?.properties || {};
  const typeErrors = [];
  for (const [field, spec] of Object.entries(properties)) {
    if (obj[field] === undefined) continue;
    const expected = spec?.type;
    if (!expected) continue;
    const actual = Array.isArray(obj[field]) ? "array" : typeof obj[field];
    if (actual !== expected) typeErrors.push(`${field}: expected ${expected}, got ${actual}`);
  }
  if (typeErrors.length) return { pass: false, reason: typeErrors.join("; ") };
  return { pass: true, reason: "schema satisfied" };
}

function runDeterministicChecks(responseJson, rubric) {
  if (!rubric || rubric.type === "none") {
    return { pass: null, details: "No deterministic rubric configured for this case" };
  }

  const text = extractText(responseJson);

  if (rubric.type === "regex") {
    try {
      const re = new RegExp(rubric.pattern, rubric.flags || "");
      const pass = re.test(text);
      return { pass, details: pass ? "Matched pattern" : `Did not match /${rubric.pattern}/${rubric.flags || ""}` };
    } catch (err) {
      return { pass: null, details: `Invalid regex rubric: ${err.message}` };
    }
  }

  if (rubric.type === "required_fields") {
    const parsed = tryParseJson(text);
    if (!parsed.ok) return { pass: false, details: "Response is not valid JSON" };
    const result = checkRequiredFields(parsed.value, rubric.fields || []);
    return {
      pass: result.pass,
      details: result.pass ? "All required fields present" : `Missing fields: ${result.missing.join(", ")}`,
    };
  }

  if (rubric.type === "json_schema") {
    const parsed = tryParseJson(text);
    if (!parsed.ok) return { pass: false, details: "Response is not valid JSON" };
    const result = checkJsonSchema(parsed.value, rubric.schema || {});
    return { pass: result.pass, details: result.reason };
  }

  return { pass: null, details: `Unknown rubric type '${rubric.type}'` };
}

module.exports = { runDeterministicChecks, extractText, tryParseJson };
