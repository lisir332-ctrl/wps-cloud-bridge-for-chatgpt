import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { listAcceptanceReports, runAcceptance, type AcceptanceSuite } from "../lib/wps-acceptance.ts";
import { type RuntimeEnv } from "../lib/wps-auth.ts";
import { classifyOperation } from "../lib/wps-catalog.ts";
import { seal } from "../lib/wps-crypto.ts";
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
    for (const file of readdirSync(dir).filter((name) => name.endsWith(".sql")).sort())
      this.sqlite.exec(readFileSync(new URL(file, dir), "utf8"));
  }
  prepare(sql: string) { return new Statement(this.sqlite, sql); }
}
const TEST_KEY = "57".repeat(32);
const TOKEN = "acceptance-test-token-must-never-be-persisted";
const json = (value: unknown): McpToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
type Args = Record<string, unknown>;
async function fixture(t: TestContext) {
  const db = new Database(); t.after(() => db.sqlite.close());
  for (const actor of ["actor-a", "actor-b"]) {
    const encrypted = await seal(TOKEN, TEST_KEY, actor, "token");
    db.sqlite.prepare("INSERT INTO wps_connections " +
      "(user_id, connection_id, token_cipher, token_iv, connected_at, expires_at, expired, verified_at) " +
      "VALUES (?, ?, ?, ?, ?, NULL, 0, NULL)").run(actor, "connection-" + actor, encrypted.cipher, encrypted.iv, Date.now());
  }
  const env: RuntimeEnv = { DB: db as unknown as D1Database, WPS_ENCRYPTION_KEY: TEST_KEY };
  return { db, env };
}

/** In-memory WPS fixtures use documented envelopes and exact returned IDs.
 * They test bridge behavior, not availability or rendering in a real account. */
function model(options: { pending?: boolean; wrongParagraph?: boolean; noFormula?: boolean; wrongPptText?: boolean; publishedForm?: boolean } = {}) {
  const calls: { name: string; args: Args }[] = [];
  let paragraphs: string[] = [];
  let spreadsheet: string[][] = [];
  let formula: string | undefined;
  let pptText = "";
  let form: Args = {};
  const callTool = async (name: string, args: Args) => {
    calls.push({ name, args: structuredClone(args) });
    assert.notEqual(classifyOperation(name, args), "sensitive");
    if (typeof args.file_id === "string") assert.ok(["created-doc", "created-sheet", "created-ppt"].includes(args.file_id));
    if (name === "create_file_with_content") {
      if (args.file_extension === "docx") {
        paragraphs = String(args.content).split("\n\n");
        return json({ code: 0, data: { file_id: "created-doc" } });
      }
      spreadsheet = structuredClone((args.rangeData as { formula: string[][] }[])[0].formula);
      return json({ code: 0, data: { file_id: "created-sheet" } });
    }
    if (name === "read_file") return options.pending
      ? json({ code: 0, data: { status: "pending", task_id: "pending-read-task" } })
      : json({ code: 0, data: { file_id: args.file_id, status: "ok", content: paragraphs.join("\n\n") } });
    if (name === "wps.texts.content") {
      assert.equal(args.paragraph_index, 1);
      if (args.verb === "update") { paragraphs[0] = String(args.content); return json({ code: 0, data: {} }); }
      return json({ code: 0, data: { content: (options.wrongParagraph ? "Unexpected text must not be overwritten" : paragraphs[0]) + "\r" } });
    }
    if (name === "sheet.get_sheets_info") return json({ sheetsInfo: [{ sheetId: 58, sheetName: "验收" }] });
    if (name === "sheet.get_range_data") {
      assert.equal(args.worksheet_id, 58);
      const rangeData = spreadsheet.flatMap((row, rowFrom) => row.map((cellText, colFrom) => ({ rowFrom, colFrom, rowTo: rowFrom, colTo: colFrom,
        cellText, originalCellValue: cellText, ...(rowFrom === 1 && colFrom === 3 && formula && !options.noFormula ? { fmlaText: formula } : {}) })));
      return json({ result: "ok", detail: { rangeData } });
    }
    if (name === "sheet.range_data_batch_update") {
      assert.equal(args.worksheet_id, 58);
      const changes = args.range_data as Args[];
      assert.equal(changes.length, 1); assert.equal(changes[0].row_from, 1); assert.equal(changes[0].col_from, 3);
      formula = String(changes[0].formula); spreadsheet[1][3] = "6";
      return json({ code: 0, msg: "ok" });
    }
    if (name === "create_empty_file") {
      assert.equal(args.on_name_conflict, "fail");
      return json({ code: 0, data: { id: "created-ppt", link_url: "https://www.kdocs.cn/l/acceptance-file" } });
    }
    if (name === "wpp.slide.items.insert") return json({ code: 0, data: { data: { slide_id: 89, slide_index: 1 } } });
    if (name === "wpp.shape.items.textboxes") {
      assert.equal(args.slide_id, 89); pptText = String((args.textboxes as Args[])[0].text);
      return json({ code: 0, data: { data: { count: 1, shape_ids: [17] } } });
    }
    if (name === "wpp.shape.items.list") return json({ code: 0, data: { list_data: { count: 2, shapes: [{ shape_id: 2 }, { shape_id: 17 }] } } });
    if (name === "wpp.shape.texts.text") {
      assert.equal(args.shape_id, 17); assert.equal(args.slide_id, 89);
      return json({ code: 0, data: { text: options.wrongPptText ? "incorrect" : pptText } });
    }
    if (name === "wpp.slide.items.list") return json({ code: 0, data: { list_data: { count: 2, slides: [{ slide_id: 7 }, { slide_id: 89 }] } } });
    if (name === "form.lite.create_draft") {
      form = { form_id: "created-form", type: "Draft", sid: "", title: args.title, questions: structuredClone(args.questions) };
      return json(form);
    }
    if (name === "form.lite.get_form_info") {
      assert.equal(args.form_id, "created-form");
      return json(options.publishedForm ? { ...form, type: "Published", sid: "public-id" } : form);
    }
    assert.fail("Unplanned upstream tool: " + name);
  };
  return { calls, deps: { clientFactory: () => ({ callTool }) } };
}

for (const suite of ["document", "spreadsheet", "presentation", "form"] as AcceptanceSuite[]) {
  test(`${suite} acceptance passes only after documented readbacks and retains summary evidence`, async (t) => {
    const { db, env } = await fixture(t); const simulation = model(); const id = crypto.randomUUID();
    const report = await runAcceptance(suite, id, "actor-a", env, simulation.deps);
    assert.equal(report.status, "passed", JSON.stringify(report));
    assert.equal(report.connectionCurrent, true); assert.equal(report.id, id); assert.equal(report.artifacts.length, 1);
    assert.equal(report.checks.at(-1)?.status, "skipped", "visual quality or publishing remains explicitly untested");
    assert.ok(report.checks.slice(0, -1).every((check) => check.status === "passed"));
    assert.equal(simulation.calls.length, { document: 6, spreadsheet: 5, presentation: 6, form: 2 }[suite]);
    assert.deepEqual((await listAcceptanceReports("actor-a", env)).reports, [report]);
    assert.deepEqual((await listAcceptanceReports("actor-b", env)).reports, []);
    const saved = JSON.stringify(db.sqlite.prepare("SELECT * FROM wps_acceptance_runs").all());
    assert.ok(!saved.includes(TOKEN)); assert.ok(!saved.includes("WPS 验收原文"));
    assert.ok(!saved.includes("请选择验收项")); assert.ok(!saved.includes("\"rangeData\""));
    const count = simulation.calls.length;
    assert.deepEqual(await runAcceptance(suite, id, "actor-a", env, simulation.deps), report);
    assert.equal(simulation.calls.length, count, "repeated request IDs never replay even successful recipes");
  });
}

test("pending content stops dependent edits and retains task ID without polling or replay", async (t) => {
  const { env } = await fixture(t); const simulation = model({ pending: true }); const id = crypto.randomUUID();
  const result = await runAcceptance("document", id, "actor-a", env, simulation.deps);
  assert.equal(result.status, "pending"); assert.equal(result.artifacts[0].fileId, "created-doc");
  assert.equal(result.artifacts[0].taskId, "pending-read-task");
  assert.equal(result.checks.find((check) => check.id === "initial_read")?.status, "pending");
  assert.equal(result.checks.find((check) => check.id === "edit")?.status, "skipped");
  await listAcceptanceReports("actor-a", env);
  await runAcceptance("document", id, "actor-a", env, simulation.deps);
  assert.deepEqual(simulation.calls.map((call) => call.name), ["create_file_with_content", "read_file"]);
});

test("a paragraph mismatch blocks the edit even when every WPS request has code 0", async (t) => {
  const { env } = await fixture(t); const simulation = model({ wrongParagraph: true });
  const result = await runAcceptance("document", crypto.randomUUID(), "actor-a", env, simulation.deps);
  assert.equal(result.status, "failed"); assert.equal(result.error?.code, "ACCEPTANCE_MISMATCH");
  assert.equal(simulation.calls.some((call) => call.args.verb === "update"), false);
});

test("a computed spreadsheet constant cannot pass the formula-preservation check", async (t) => {
  const { env } = await fixture(t); const simulation = model({ noFormula: true });
  const result = await runAcceptance("spreadsheet", crypto.randomUUID(), "actor-a", env, simulation.deps);
  assert.equal(result.status, "uncertain");
  assert.equal(result.checks.find((check) => check.id === "values")?.status, "passed");
  assert.equal(result.checks.find((check) => check.id === "formula")?.status, "uncertain");
  assert.equal(simulation.calls.length, 5);
});

test("presentation and form readback mismatches cannot be mistaken for successful creation", async (t) => {
  const { env } = await fixture(t);
  for (const [suite, options] of [["presentation", { wrongPptText: true }], ["form", { publishedForm: true }]] as const) {
    const simulation = model(options);
    const result = await runAcceptance(suite, crypto.randomUUID(), "actor-a", env, simulation.deps);
    assert.equal(result.status, "failed"); assert.equal(result.artifacts.length, 1);
    assert.equal(result.error?.code, "ACCEPTANCE_MISMATCH");
    assert.equal(simulation.calls.some((call) => /publish|delete|share|aippt/.test(call.name)), false);
  }
});

test("atomic actor-scoped claim prevents concurrent duplicate creates and suite reuse", async (t) => {
  const { env } = await fixture(t); let release!: (value: McpToolResult) => void; let entered!: () => void;
  const pending = new Promise<McpToolResult>((resolve) => { release = resolve; });
  const called = new Promise<void>((resolve) => { entered = resolve; });
  let calls = 0;
  const deps = { clientFactory: () => ({ callTool: async () => { calls++; entered(); return pending; } }) };
  const id = crypto.randomUUID();
  const first = runAcceptance("form", id, "actor-a", env, deps);
  await called;
  const duplicate = await runAcceptance("form", id, "actor-a", env, deps);
  assert.equal(duplicate.status, "running"); assert.equal(calls, 1);
  await assert.rejects(runAcceptance("document", id, "actor-a", env, deps), { code: "REQUEST_ID_REUSED" });
  release(json({ code: 0, data: { status: "pending", task_id: "pending-create" } }));
  assert.equal((await first).status, "pending");
  assert.equal((await runAcceptance("form", id, "actor-b", env, deps)).status, "pending");
  assert.equal(calls, 2, "another authenticated actor has a separate claim namespace");
});

test("partial create IDs survive errors, while messages, credentials and raw document bodies are not stored", async (t) => {
  const { db, env } = await fixture(t); const id = crypto.randomUUID(); let calls = 0;
  const deps = { clientFactory: () => ({ callTool: async () => {
    calls++; const error = new WpsError("UPSTREAM_ERROR", TOKEN + " private-document-body", 502);
    error.partialResult = { code: 123, data: { file_id: "partial-created-file", body: "private-document-body" } };
    throw error;
  } }) };
  const result = await runAcceptance("document", id, "actor-a", env, deps);
  assert.equal(result.status, "uncertain"); assert.equal(result.artifacts[0].fileId, "partial-created-file");
  assert.equal((await runAcceptance("document", id, "actor-a", env, deps)).status, "uncertain");
  assert.equal(calls, 1);
  const saved = JSON.stringify(db.sqlite.prepare("SELECT * FROM wps_acceptance_runs").all());
  assert.ok(!saved.includes(TOKEN)); assert.ok(!saved.includes("private-document-body"));
});

test("connection changes stop later calls and historical passes are not current-account evidence", async (t) => {
  const { db, env } = await fixture(t); const simulation = model();
  const passed = await runAcceptance("form", crypto.randomUUID(), "actor-a", env, simulation.deps);
  assert.equal(passed.status, "passed");
  const deps = { clientFactory: () => ({ callTool: async () => {
    db.sqlite.prepare("UPDATE wps_connections SET connection_id='changed-account' WHERE user_id='actor-a'").run();
    return json({ code: 0, data: { file_id: "created-doc" } });
  } }) };
  const result = await runAcceptance("document", crypto.randomUUID(), "actor-a", env, deps);
  assert.equal(result.status, "failed"); assert.equal(result.error?.code, "CONNECTION_CHANGED");
  assert.equal(result.connectionCurrent, false); assert.equal(result.artifacts[0].fileId, "created-doc");
  assert.ok((await listAcceptanceReports("actor-a", env)).reports.every((report) => !report.connectionCurrent));
});

test("time budget keeps the new artifact and never starts the next operation", async (t) => {
  const { env } = await fixture(t); let now = Date.now(); let calls = 0;
  const deps = { clock: () => now, clientFactory: () => ({ callTool: async () => {
    calls++; now += 76_000; return json({ code: 0, data: { file_id: "created-doc" } });
  } }) };
  const result = await runAcceptance("document", crypto.randomUUID(), "actor-a", env, deps);
  assert.equal(result.status, "uncertain"); assert.equal(result.error?.code, "ACCEPTANCE_TIME_BUDGET");
  assert.equal(result.artifacts[0].fileId, "created-doc"); assert.equal(calls, 1);
});

test("a per-call deadline stops an unresponsive write without replaying it", async (t) => {
  const { env } = await fixture(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let entered!: () => void; let calls = 0;
  const called = new Promise<void>((resolve) => { entered = resolve; });
  const deps = { clientFactory: () => ({ callTool: async () => {
    calls++; entered(); return new Promise<McpToolResult>(() => {});
  } }) };
  const id = crypto.randomUUID(); const running = runAcceptance("document", id, "actor-a", env, deps);
  await called; t.mock.timers.tick(30_001);
  const report = await running;
  assert.equal(report.status, "uncertain"); assert.equal(report.error?.code, "ACCEPTANCE_CALL_TIMEOUT");
  assert.equal((await runAcceptance("document", id, "actor-a", env, deps)).status, "uncertain");
  assert.equal(calls, 1);
});

test("GET marks stale running snapshots uncertain and does not invoke a WPS client", async (t) => {
  const { db, env } = await fixture(t);
  const checks = [{ id: "create", title: "创建文件", status: "pending", detail: "正在执行并核对实际结果。" },
    { id: "read", title: "读取文件", status: "pending", detail: "尚未开始。" }];
  const id = crypto.randomUUID(); const earlier = Date.now() - 90_000;
  db.sqlite.prepare("INSERT INTO wps_acceptance_runs " +
    "(user_id,request_id,suite,connection_id,status,started_at,updated_at,checks_json,artifacts_json,error_json) " +
    "VALUES (?,?,'document','connection-actor-a','running',?,?,?,'[]',NULL)").run("actor-a", id, earlier, earlier, JSON.stringify(checks));
  const report = (await listAcceptanceReports("actor-a", env)).reports[0];
  assert.equal(report.status, "uncertain"); assert.equal(report.error?.code, "ACCEPTANCE_INTERRUPTED");
  assert.equal(report.checks[0].status, "uncertain"); assert.equal(report.checks[1].status, "skipped");
  const repeated = await runAcceptance("document", id, "actor-a", env, { clientFactory: () => { assert.fail("must not reconnect or retry"); } });
  assert.equal(repeated.status, "uncertain");
});

test("unrecognized result formats fail closed and credential-bearing URLs are not persisted", async (t) => {
  const { db, env } = await fixture(t); let calls = 0;
  const result = await runAcceptance("presentation", crypto.randomUUID(), "actor-a", env, { clientFactory: () => ({ callTool: async () => {
    calls++;
    return calls === 1 ? json({ code: 0, data: { id: "created-ppt", link_url: "https://www.kdocs.cn/l/file?token=secret-query" } })
      : { content: [{ type: "text", text: "explanation" }, { type: "text", text: JSON.stringify({ code: 0, data: { data: { slide_id: 89 } } }) }] };
  } }) });
  assert.equal(result.status, "uncertain"); assert.equal(calls, 2); assert.equal(result.artifacts[0].url, undefined);
  assert.ok(!JSON.stringify(db.sqlite.prepare("SELECT * FROM wps_acceptance_runs").all()).includes("secret-query"));
});
