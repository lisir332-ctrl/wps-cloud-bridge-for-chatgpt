import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { type RuntimeEnv } from "../lib/wps-auth.ts";
import { seal } from "../lib/wps-crypto.ts";
import { executeCatalogCall, executeGatewayTool, gatewayTools, previewSensitiveCall, runWorkflow } from "../lib/wps-gateway.ts";
import { WpsExecutionLedger } from "../lib/wps-executions.ts";
import { WpsError, type McpToolResult } from "../lib/wps-upstream.ts";

type Bind = string | number | bigint | null | Uint8Array;
class Statement {
  constructor(private db: DatabaseSync, private sql: string, private args: Bind[] = []) {}
  bind(...args: Bind[]) { return new Statement(this.db, this.sql, args); }
  async first<T>() { return (this.db.prepare(this.sql).get(...this.args) as T | undefined) ?? null; }
  async run() { return { success: true, meta: { changes: Number(this.db.prepare(this.sql).run(...this.args).changes) } }; }
}
class Database {
  sqlite = new DatabaseSync(":memory:");
  constructor() {
    const dir = new URL("../drizzle/", import.meta.url);
    for (const file of readdirSync(dir).filter((file) => file.endsWith(".sql")).sort())
      this.sqlite.exec(readFileSync(new URL(file, dir), "utf8"));
  }
  prepare(sql: string) { return new Statement(this.sqlite, sql); }
}
const TEST_KEY = "37".repeat(32);
const json = (value: unknown): McpToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] });

async function fixture(t: TestContext) {
  const db = new Database();
  t.after(() => db.sqlite.close());
  for (const actor of ["actor-a", "actor-b"]) {
    const encrypted = await seal("test-token-" + actor, TEST_KEY, actor, "token");
    db.sqlite.prepare("INSERT INTO wps_connections " +
      "(user_id, connection_id, token_cipher, token_iv, connected_at, expires_at, expired, verified_at) " +
      "VALUES (?, ?, ?, ?, ?, NULL, 0, NULL)").run(actor, "connection-" + actor, encrypted.cipher, encrypted.iv, Date.now());
  }
  const env: RuntimeEnv = { DB: db as unknown as D1Database, WPS_ENCRYPTION_KEY: TEST_KEY };
  return { db, env };
}

test("gateway separates read/write/sensitive and gives every legacy write a request ID", () => {
  const tools = gatewayTools();
  assert.equal(tools.length, 21);
  assert.equal(tools.find((tool) => tool.name === "wps_call_read")?.annotations.readOnlyHint, true);
  for (const name of ["wps_call_write", "wps_call_sensitive", "wps_workflow_run", "wps_create_document", "wps_create_spreadsheet", "wps_replace_paragraphs", "wps_write_cells"]) {
    const tool = tools.find((item) => item.name === name)!;
    assert.equal(tool.annotations.readOnlyHint, false, name);
    assert.equal(tool.annotations.idempotentHint, false, name);
    assert.ok(tool.inputSchema.required?.includes("request_id"), name);
  }
});

test("free and member guidance never invents account entitlements", async () => {
  const best = JSON.parse((await executeGatewayTool("wps_access_options", {}, "actor-a", {})).content[0].text);
  assert.equal(best.accountTier, "unknown");
  assert.equal(best.mode, "best_first");
  assert.equal(best.pdfConversion.freeFallback.arguments.is_free_convert, true);
  assert.match(best.pdfConversion.freeFallback.condition, /未产生结果/);
  const free = JSON.parse((await executeGatewayTool("wps_access_options", { mode: "free_only" }, "actor-a", {})).content[0].text);
  assert.equal(free.accountTier, "unknown");
  assert.equal(free.pdfConversion.arguments.is_free_convert, true);
  await assert.rejects(executeGatewayTool("wps_access_options", { mode: "vip_confirmed" }, "actor-a", {}), { code: "INVALID_ARGUMENTS" });
});

test("wrong-risk entry points and broad confirmations cannot make upstream calls", async (t) => {
  const { env } = await fixture(t);
  let calls = 0;
  const deps = { clientFactory: () => ({ callTool: async () => { calls++; return json({}); } }) };
  await assert.rejects(executeCatalogCall({ tool: "form.lite.publish_draft", arguments: { form_id: "f" }, mode: "read" }, "actor-a", env, deps), { code: "OPERATION_MODE_MISMATCH" });
  await assert.rejects(executeCatalogCall({ tool: "form.lite.publish_draft", arguments: { form_id: "f" }, mode: "write", requestId: crypto.randomUUID() }, "actor-a", env, deps), { code: "OPERATION_MODE_MISMATCH" });
  await assert.rejects(executeCatalogCall({ tool: "form.lite.publish_draft", arguments: { form_id: "f" }, mode: "sensitive", confirmed: true }, "actor-a", env, deps), { code: "INVALID_ARGUMENTS" });
  await assert.rejects(executeCatalogCall({ tool: "form.lite.publish_draft", arguments: { form_id: "f" }, mode: "sensitive", requestId: crypto.randomUUID(), confirmedTool: "form.lite.publish_draft" }, "actor-a", env, deps), { code: "REVIEW_REQUIRED" });
  assert.equal(calls, 0);
});

test("sensitive review binds actor, account, exact args, exact tool and execution ID", async (t) => {
  const { db, env } = await fixture(t);
  const preview = await previewSensitiveCall("form.lite.publish_draft", { form_id: "form-one" }, "actor-a", env);
  assert.ok(!JSON.stringify(preview).includes("test-token-"));
  const input = { tool: preview.tool, arguments: preview.arguments, mode: "sensitive", reviewToken: preview.reviewToken,
    confirmedTool: preview.tool, requestId: preview.requestId };
  let calls = 0;
  const deps = { clientFactory: () => ({ callTool: async () => { calls++; return json({ code: 0 }); } }) };
  for (const changed of [
    { ...input, arguments: { form_id: "another-form" } },
    { ...input, confirmedTool: "share_file" },
    { ...input, requestId: crypto.randomUUID() },
    { ...input, reviewToken: preview.reviewToken.slice(0, -2) + "xx" },
  ]) await assert.rejects(executeCatalogCall(changed, "actor-a", env, deps), { code: "REVIEW_REQUIRED" });
  await assert.rejects(executeCatalogCall(input, "actor-b", env, deps), { code: "REVIEW_REQUIRED" });
  db.sqlite.prepare("UPDATE wps_connections SET connection_id='changed' WHERE user_id='actor-a'").run();
  await assert.rejects(executeCatalogCall(input, "actor-a", env, deps), { code: "REVIEW_REQUIRED" });
  db.sqlite.prepare("UPDATE wps_connections SET connection_id='connection-actor-a' WHERE user_id='actor-a'").run();
  assert.equal((await executeCatalogCall(input, "actor-a", env, deps)).status, "succeeded");
  assert.equal((await executeCatalogCall(input, "actor-a", env, deps)).status, "already_run");
  assert.equal(calls, 1);
});

test("concurrent duplicate writes make one upstream call, with no plaintext parameters in ledger", async (t) => {
  const { db, env } = await fixture(t);
  let resolve!: (value: McpToolResult) => void;
  const pending = new Promise<McpToolResult>((done) => { resolve = done; });
  let notify!: () => void;
  const called = new Promise<void>((done) => { notify = done; });
  let calls = 0;
  const deps = { clientFactory: () => ({ callTool: async () => { calls++; notify(); return pending; } }) };
  const input = { tool: "form.lite.create_draft", arguments: { title: "private-questionnaire-title", questions: [] }, mode: "write", requestId: crypto.randomUUID() };
  const first = executeCatalogCall(input, "actor-a", env, deps);
  await called;
  const duplicate = await executeCatalogCall(input, "actor-a", env, deps);
  assert.equal(duplicate.status, "unknown_after_timeout");
  resolve(json({ form_id: "created" }));
  assert.equal((await first).status, "succeeded");
  assert.equal((await executeCatalogCall(input, "actor-a", env, deps)).status, "already_run");
  assert.equal(calls, 1);
  const ledger = db.sqlite.prepare("SELECT * FROM wps_executions").all();
  assert.equal(JSON.stringify(ledger).includes("private-questionnaire-title"), false);
  assert.equal(JSON.stringify(ledger).includes("test-token-"), false);
  await assert.rejects(executeCatalogCall({ ...input, arguments: { title: "changed", questions: [] } }, "actor-a", env, deps), { code: "REQUEST_ID_REUSED" });
});

test("legacy convenience writes also deduplicate and retain their precise transforms", async (t) => {
  const { env } = await fixture(t);
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const deps = { clientFactory: () => ({ callTool: async (name: string, args: Record<string, unknown>) => { calls.push({ name, args }); return json({ file_id: "new" }); } }) };
  const args = { name: "新文档", content: "# 内容", request_id: crypto.randomUUID() };
  const result = await executeGatewayTool("wps_create_document", args, "actor-a", env, deps);
  assert.equal(JSON.parse(result.content[0].text).status, "succeeded");
  assert.equal(JSON.parse((await executeGatewayTool("wps_create_document", args, "actor-a", env, deps)).content[0].text).status, "already_run");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { name: "create_file_with_content", args: { name: "新文档", file_extension: "docx", content: "# 内容" } });
  await assert.rejects(executeGatewayTool("wps_create_document", { name: "x", content: "y" }, "actor-a", env, deps), { code: "REQUEST_ID_REQUIRED" });
});

test("workflow execution IDs are durable, actor-scoped and never replay a timed out write", async (t) => {
  const { env } = await fixture(t);
  let calls = 0;
  const deps = { clientFactory: () => ({ callTool: async () => { calls++; throw new WpsError("UPSTREAM_TIMEOUT", "timeout", 504); } }) };
  const plan = { version: 1, steps: [{ id: "create", tool: "form.lite.create_draft", arguments: { title: "问卷", questions: [] } }] };
  const id = crypto.randomUUID();
  assert.equal((await runWorkflow(plan, "actor-a", env, id, deps)).status, "uncertain");
  assert.equal((await runWorkflow(plan, "actor-a", env, id, deps)).status, "unknown_after_timeout");
  assert.equal(calls, 1);
  assert.equal((await runWorkflow(plan, "actor-b", env, id, deps)).status, "uncertain");
  assert.equal(calls, 2);
});

test("execution records are scoped by authenticated actor and hash", async (t) => {
  const { env } = await fixture(t);
  const ledger = new WpsExecutionLedger(env.DB!);
  const id = crypto.randomUUID();
  assert.equal((await ledger.claim("actor-a", id, "hash-one")).claimed, true);
  assert.equal((await ledger.claim("actor-a", id, "hash-one")).claimed, false);
  assert.equal((await ledger.claim("actor-b", id, "hash-one")).claimed, true);
  await assert.rejects(ledger.claim("actor-a", id, "different"), { code: "REQUEST_ID_REUSED" });
});
