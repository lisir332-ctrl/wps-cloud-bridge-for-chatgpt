import assert from "node:assert/strict";
import test from "node:test";
import { getCatalogTool, listCatalog, type CatalogTool } from "../lib/wps-catalog.ts";
import { executeWorkflow, validateCatalogArguments, validateWorkflow } from "../lib/wps-workflows.ts";
import { WpsError, type McpToolResult } from "../lib/wps-upstream.ts";

const json = (value: unknown): McpToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const draft = (id: string) => ({ id, tool: "form.lite.create_draft", arguments: { title: "体验调查", questions: [
  { question: "你最希望改进什么？", type: "input" },
] } });

function schemaValue(schema: unknown, name = ""): unknown {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return null;
  const s = schema as Record<string, unknown>;
  if (Array.isArray(s.enum)) return s.enum[0];
  if (s.type === "string") {
    if (s.items && typeof s.items === "object" && "enum" in s.items && Array.isArray(s.items.enum)) return s.items.enum[0];
    return name === "url" || name.endsWith("_url") ? "https://www.kdocs.cn/l/example" : "example";
  }
  if (s.type === "integer" || s.type === "number") return 1;
  if (s.type === "boolean") return true;
  if (s.type === "array") return [];
  if (s.type === "object") {
    const props = (s.properties || {}) as Record<string, unknown>;
    const required = Array.isArray(s.required) ? s.required as string[] : [];
    return Object.fromEntries(required.map((key) => [key, schemaValue(props[key], key)]));
  }
  return null;
}

test("all 619 captured schemas are accepted without executing business calls", () => {
  let count = 0;
  for (let offset = 0; ; offset += 100) {
    const page = listCatalog({ offset, limit: 100 });
    for (const tool of page.items) {
      const args = schemaValue(tool.inputSchema);
      assert.doesNotThrow(() => validateCatalogArguments(tool, args), tool.name);
      count++;
    }
    if (page.nextOffset === null) break;
  }
  assert.equal(count, 619);
});

test("JSON Schema defaults permit open business records, explicit false rejects extra keys", () => {
  const base = getCatalogTool("form.lite.create_draft")!;
  const open: CatalogTool = { ...base, inputSchema: { type: "object", properties: { record: { type: "object", properties: {} } } } };
  assert.doesNotThrow(() => validateCatalogArguments(open, { record: { fieldName: "data", arbitraryColumn: 7 } }));
  const closed = { ...open, inputSchema: { type: "object", properties: {}, additionalProperties: false } };
  assert.throws(() => validateCatalogArguments(closed, { extra: 1 }), { code: "INVALID_ARGUMENTS" });
  const future = { ...open, inputSchema: { type: "object", anyOf: [{ required: ["name"] }] } };
  assert.throws(() => validateCatalogArguments(future, { name: "x" }), { code: "SCHEMA_UNSUPPORTED" });
});

test("preflight validates every step and rejects a later invalid step before any call", async () => {
  const plan = { version: 1, steps: [draft("first"), { id: "broken", tool: "form.lite.create_draft", arguments: { questions: [] } }] };
  const preview = validateWorkflow(plan);
  assert.equal(preview.valid, false);
  assert.equal(preview.errors[0].step, "broken");
  let calls = 0;
  const result = await executeWorkflow(plan, { callTool: async () => { calls++; return json({}); } });
  assert.equal(calls, 0);
  assert.equal(result.status, "failed");
});

test("prior result references preserve native types and are schema-checked before dispatch", async () => {
  const plan = { version: 1, on_error: "stop", steps: [
    draft("draft"),
    { id: "read", tool: "form.lite.get_form_info", arguments: { form_id: { $ref: { step: "draft", pointer: "/data/form_id" } } } },
  ] };
  assert.equal(validateWorkflow(plan).steps[1].status, "deferred");
  const seen: { name: string; args: Record<string, unknown> }[] = [];
  const result = await executeWorkflow(plan, { callTool: async (name, args) => {
    seen.push({ name, args });
    return json(seen.length === 1 ? { code: 0, data: { form_id: "form-actual" } } : { code: 0, data: { title: "体验调查" } });
  } });
  assert.equal(result.status, "succeeded");
  assert.deepEqual(seen[1].args, { form_id: "form-actual" });
  let invalidCalls = 0;
  const invalid = await executeWorkflow(plan, { callTool: async () => { invalidCalls++; return json({ data: { form_id: 123 } }); } });
  assert.equal(invalidCalls, 1, "a numeric reference cannot bypass a string schema");
  assert.equal(invalid.status, "partial");
  assert.equal(invalid.steps[1].status, "failed");
});

test("unknown references, future steps, prototype access and executable values are rejected", () => {
  for (const pointer of ["/__proto__/x", "/constructor/prototype", "/x~2y"]) {
    assert.equal(validateWorkflow({ version: 1, steps: [draft("first"), {
      id: "read", tool: "form.lite.get_form_info", arguments: { form_id: { $ref: { step: "first", pointer } } },
    }] }).valid, false);
  }
  assert.equal(validateWorkflow({ version: 1, steps: [{
    id: "read", tool: "form.lite.get_form_info", arguments: { form_id: { $ref: { step: "later", pointer: "" } } },
  }, draft("later")] }).valid, false);
  assert.equal(validateWorkflow({ version: 1, steps: [draft("first")], javascript: "fetch('https://evil.example')" }).valid, false);
  assert.equal(validateWorkflow({ version: 1, steps: [{ ...draft("first"), arguments: { title: () => "x", questions: [] } }] }).valid, false);
  assert.equal(validateWorkflow({ version: 1, steps: [{ id: "raw", tool: "http_fetch", arguments: {} }] }).valid, false);
});

test("publishing and unresolved destructive selectors cannot enter a normal workflow", () => {
  const published = validateWorkflow({ version: 1, steps: [{ id: "publish", tool: "form.lite.publish_draft", arguments: { form_id: "f" } }] });
  assert.equal(published.valid, false);
  assert.equal(published.errors[0].code, "SENSITIVE_WORKFLOW_FORBIDDEN");
  const hiddenVerb = validateWorkflow({ version: 1, steps: [
    { id: "read", tool: "get_file_info", arguments: { file_id: "f" } },
    { id: "mixed", tool: "wps.texts.content", arguments: {
      file_id: "f", scope: "documents", verb: { $ref: { step: "read", pointer: "/verb" } },
    } },
  ] });
  assert.equal(hiddenVerb.valid, false);
});

test("a referenced argument which becomes sensitive is rejected again at runtime", async () => {
  const plan = { version: 1, steps: [
    { id: "read", tool: "get_file_info", arguments: { file_id: "f" } },
    { id: "update", tool: "form.lite.update_draft", arguments: {
      form_id: "f", questions: { $ref: { step: "read", pointer: "/questions" } },
    } },
  ] };
  assert.equal(validateWorkflow(plan).valid, true);
  let count = 0;
  const result = await executeWorkflow(plan, { callTool: async () => { count++; return json({ questions: [] }); } });
  assert.equal(count, 1);
  assert.equal(result.steps[1].error?.code, "SENSITIVE_WORKFLOW_FORBIDDEN");
});

test("a timed out write is never retried and completed results plus skipped steps survive", async () => {
  const plan = { version: 1, steps: [draft("first"), draft("second"), draft("third")] };
  let calls = 0;
  const result = await executeWorkflow(plan, { callTool: async () => {
    calls++;
    if (calls === 2) throw new WpsError("UPSTREAM_TIMEOUT", "timeout", 504);
    return json({ data: { form_id: "created-first" } });
  } });
  assert.equal(calls, 2);
  assert.equal(result.status, "uncertain");
  assert.deepEqual(result.steps.map((step) => step.status), ["succeeded", "uncertain", "skipped"]);
  assert.deepEqual(result.steps[0].output, { data: { form_id: "created-first" } });
});

test("sanitized partial creation results remain available even when the upstream reports failure", async () => {
  const error = new WpsError("UPSTREAM_ERROR", "write incomplete", 502);
  error.partialResult = { code: 500, data: { file_id: "already-created", param_detail: "content conversion failed" } };
  const result = await executeWorkflow({ version: 1, steps: [draft("create")] }, { callTool: async () => { throw error; } });
  assert.equal(result.status, "uncertain");
  assert.deepEqual(result.steps[0].error?.partialResult, error.partialResult);
});

test("tool errors and elapsed budget stop later calls, retaining real outcomes", async () => {
  let calls = 0;
  const errors = await executeWorkflow({ version: 1, steps: [draft("one"), draft("two")] }, {
    callTool: async () => { calls++; return { ...json({ data: { form_id: "partial-id" } }), isError: true }; },
  });
  assert.equal(calls, 1);
  assert.equal(errors.status, "uncertain");
  let now = 0;
  const budget = await executeWorkflow({ version: 1, steps: [draft("one"), draft("two")] }, {
    clock: () => now,
    callTool: async () => { now = 80_000; return json({ form_id: "created" }); },
  });
  assert.equal(budget.status, "partial");
  assert.equal(budget.steps[1].error?.code, "WORKFLOW_TIME_BUDGET");
});
