const test = require("node:test");
const assert = require("node:assert/strict");
const { runDeterministicChecks, extractText } = require("../server/evaluation/deterministic");

function openaiResponse(text) {
  return { choices: [{ message: { content: text } }] };
}
function anthropicResponse(text) {
  return { content: [{ type: "text", text }] };
}

test("extractText handles both OpenAI and Anthropic response shapes", () => {
  assert.equal(extractText(openaiResponse("hi")), "hi");
  assert.equal(extractText(anthropicResponse("hi")), "hi");
});

test("no rubric configured returns pass: null, not false", () => {
  const result = runDeterministicChecks(openaiResponse("anything"), null);
  assert.equal(result.pass, null);
});

test("required_fields rubric passes when all fields present", () => {
  const response = openaiResponse(JSON.stringify({ ticket_id: "T1", priority: "high" }));
  const result = runDeterministicChecks(response, { type: "required_fields", fields: ["ticket_id", "priority"] });
  assert.equal(result.pass, true);
});

test("required_fields rubric fails and names the missing field", () => {
  const response = openaiResponse(JSON.stringify({ ticket_id: "T1" }));
  const result = runDeterministicChecks(response, { type: "required_fields", fields: ["ticket_id", "priority"] });
  assert.equal(result.pass, false);
  assert.match(result.details, /priority/);
});

test("json_schema rubric validates types", () => {
  const response = anthropicResponse(JSON.stringify({ count: "not-a-number" }));
  const result = runDeterministicChecks(response, { type: "json_schema", schema: { required: ["count"], properties: { count: { type: "number" } } } });
  assert.equal(result.pass, false);
});

test("json_schema rubric passes valid structured output", () => {
  const response = anthropicResponse(JSON.stringify({ count: 3 }));
  const result = runDeterministicChecks(response, { type: "json_schema", schema: { required: ["count"], properties: { count: { type: "number" } } } });
  assert.equal(result.pass, true);
});

test("regex rubric matches against raw text", () => {
  const response = openaiResponse("Order #12345 confirmed");
  const result = runDeterministicChecks(response, { type: "regex", pattern: "Order #\\d+" });
  assert.equal(result.pass, true);
});

test("required_fields rubric fails cleanly on non-JSON response", () => {
  const response = openaiResponse("this is not json at all");
  const result = runDeterministicChecks(response, { type: "required_fields", fields: ["x"] });
  assert.equal(result.pass, false);
  assert.match(result.details, /not valid JSON/);
});
