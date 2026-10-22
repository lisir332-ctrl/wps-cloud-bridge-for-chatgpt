import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { type RuntimeEnv } from "../lib/wps-auth.ts";
import { seal } from "../lib/wps-crypto.ts";
import { type ValidatedPresentationInput } from "../lib/wps-presentation-file.ts";
import { createPresentation, verifyPresentation } from "../lib/wps-presentation-task.ts";
import { WpsError, type McpToolResult } from "../lib/wps-upstream.ts";

type Bind = string | number | bigint | null | Uint8Array;
type Args = Record<string, unknown>;
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

const TEST_KEY = "74".repeat(32);
const TOKEN = "presentation-task-test-token-not-real";
const FILE_ID = "new-presentation-52";
const FILE_URL = "https://www.kdocs.cn/l/new-presentation-52";
const GENERATED_BASE64 = Buffer.from("isolated-generator-fixture").toString("base64");
const outline = {
  title: "项目进展汇报", theme: "forest" as const,
  slides: [
    { title: "本周进展", bullets: ["云端连接已完成", "标准文稿已生成"] },
    { title: "下一步计划", bullets: ["核对真实回读", "审阅成品排版"] },
  ],
};
const json = (value: unknown): McpToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] });

async function fixture(t: TestContext) {
  const db = new Database();
  t.after(() => db.sqlite.close());
  for (const actor of ["actor-a", "actor-b"]) {
    const encrypted = await seal(TOKEN, TEST_KEY, actor, "token");
    db.sqlite.prepare("INSERT INTO wps_connections " +
      "(user_id, connection_id, token_cipher, token_iv, connected_at, expires_at, expired, verified_at) " +
      "VALUES (?, ?, ?, ?, ?, NULL, 0, NULL)").run(actor, `connection-${actor}`, encrypted.cipher, encrypted.iv, Date.now());
  }
  const env: RuntimeEnv = { DB: db as unknown as D1Database, WPS_ENCRYPTION_KEY: TEST_KEY };
  return { db, env };
}

/** Regression fixtures encode the documented response shapes. No real WPS
 * account, upload, extraction or Office rendering is exercised by this file.
 * Actual PPTX bytes are independently tested in presentation-file.test.ts. */
function kdc() {
  const textbox = (...text: string[]) => ({ type: "textbox", textbox: { blocks: [{ para: { runs: text.map((text) => ({ text })) } }] } });
  return {
    file_id: FILE_ID, status: "ok", content_format: "kdc", warnings: [],
    content: { slide_containers: [{ category: "slides", slides: [
      { shape_tree: [textbox("本周", "进展"), textbox("云端连接已完成"), textbox("标准文稿已生成"), textbox("项目进展汇报"), textbox("1 / 2")] },
      { shape_tree: [textbox("下一步计划"), textbox("核对真实回读"), textbox("审阅成品排版"), textbox("项目进展汇报"), textbox("2 / 2")] },
    ] }] },
  };
}

function simulation(read: (args: Args) => Promise<McpToolResult> | McpToolResult = () => json({ code: 0, data: kdc() })) {
  const calls: { name: string; args: Args }[] = [];
  let generations = 0;
  return {
    calls, generations: () => generations,
    deps: {
      generate: async (input: ValidatedPresentationInput) => {
        generations++;
        return { name: `${input.title}.pptx`, contentBase64: GENERATED_BASE64,
          slideCount: input.slides.length, expectedTitles: input.slides.map((slide) => slide.title) };
      },
      clientFactory: () => ({ callTool: async (name: string, args: Args) => {
        calls.push({ name, args: structuredClone(args) });
        if (name === "upload_new_file") return json({ code: 0, data: { id: FILE_ID, link_url: FILE_URL } });
        if (name === "read_file") return read(args);
        assert.fail(`Unplanned WPS tool: ${name}`);
      } }),
    },
  };
}

test("upload uses the returned data.id and passes only after each KDC page matches", async (t) => {
  const { db, env } = await fixture(t); const mock = simulation(); const request = crypto.randomUUID();
  const result = await createPresentation(outline, request, "actor-a", env, mock.deps);
  assert.ok("verification" in result);
  assert.equal(result.status, "succeeded"); assert.equal(result.verification.status, "passed");
  assert.equal(result.fileId, FILE_ID); assert.equal(result.url, FILE_URL); assert.equal(result.slideCount, 2);
  assert.equal(mock.generations(), 1);
  assert.deepEqual(mock.calls, [
    { name: "upload_new_file", args: { name: "项目进展汇报.pptx", content_base64: GENERATED_BASE64, content_format: "pptx" } },
    { name: "read_file", args: { file_id: FILE_ID, format: "kdc", enable_upload_medias: false } },
  ]);
  const duplicate = await createPresentation(outline, request, "actor-a", env, mock.deps);
  assert.equal(duplicate.status, "already_run"); assert.equal(mock.calls.length, 2); assert.equal(mock.generations(), 1);
  const stored = JSON.stringify(db.sqlite.prepare("SELECT * FROM wps_executions").all());
  for (const privateValue of [TOKEN, outline.title, GENERATED_BASE64, FILE_ID]) assert.equal(stored.includes(privateValue), false);
});

test("wrong page text, duplicate replacement, page count and file ID cannot pass a code-0 readback", async (t) => {
  const { env } = await fixture(t);
  const variants = [
    () => { const value = kdc(); value.content.slide_containers[0].slides.reverse(); return value; },
    () => { const value = kdc(); value.content.slide_containers[0].slides[0].shape_tree[2] = structuredClone(value.content.slide_containers[0].slides[0].shape_tree[1]); return value; },
    () => { const value = kdc(); value.content.slide_containers[0].slides.pop(); return value; },
    () => ({ ...kdc(), file_id: "an-unrelated-document" }),
  ];
  for (const variant of variants) {
    const mock = simulation(() => json({ code: 0, data: variant() }));
    const result = await createPresentation(outline, crypto.randomUUID(), "actor-a", env, mock.deps);
    assert.ok("verification" in result);
    assert.equal(result.status, "failed"); assert.equal(result.verification.status, "failed");
    assert.equal(result.fileId, FILE_ID, "Keep the created file for inspection; never delete it");
    assert.deepEqual(mock.calls.map((call) => call.name), ["upload_new_file", "read_file"]);
  }
});

test("pending extraction keeps its task ID and continuation performs read_file only", async (t) => {
  const { env } = await fixture(t); let reads = 0;
  const mock = simulation(() => ++reads === 1
    ? json({ code: 0, data: { status: "pending", task_id: "read-task-81" } })
    : json({ code: 0, data: kdc() }));
  const request = crypto.randomUUID();
  const created = await createPresentation(outline, request, "actor-a", env, mock.deps);
  assert.ok("verification" in created);
  assert.equal(created.status, "pending"); assert.equal(created.fileId, FILE_ID);
  assert.equal(created.verification.status, "pending"); assert.equal(created.verification.taskId, "read-task-81");
  const verified = await verifyPresentation(outline, created.fileId, created.verification.taskId, "actor-a", env, mock.deps);
  assert.equal(verified.status, "passed");
  assert.deepEqual(mock.calls.at(-1), { name: "read_file", args: {
    file_id: FILE_ID, format: "kdc", enable_upload_medias: false, task_id: "read-task-81",
  } });
  assert.equal((await createPresentation(outline, request, "actor-a", env, mock.deps)).status, "already_run");
  assert.deepEqual(mock.calls.map((call) => call.name), ["upload_new_file", "read_file", "read_file"]);
  assert.equal(mock.generations(), 1);
});

test("the same UUID cannot upload concurrently or be reused with a changed outline", async (t) => {
  const { env } = await fixture(t); const mock = simulation();
  let release!: (value: McpToolResult) => void; let entered!: () => void;
  const pending = new Promise<McpToolResult>((resolve) => { release = resolve; });
  const called = new Promise<void>((resolve) => { entered = resolve; });
  const names: string[] = [];
  const deps = { ...mock.deps, clientFactory: () => ({ callTool: async (name: string) => {
    names.push(name);
    if (name === "upload_new_file") { entered(); return pending; }
    if (name === "read_file") return json({ code: 0, data: kdc() });
    assert.fail(`Unexpected tool ${name}`);
  } }) };
  const request = crypto.randomUUID();
  const first = createPresentation(outline, request, "actor-a", env, deps);
  await called;
  const duplicate = await createPresentation(outline, request, "actor-a", env, deps);
  assert.equal(duplicate.status, "unknown_after_timeout"); assert.equal(mock.generations(), 1);
  await assert.rejects(createPresentation({ ...outline, title: "另一份提纲" }, request, "actor-a", env, deps), { code: "REQUEST_ID_REUSED" });
  release(json({ code: 0, data: { id: FILE_ID } }));
  assert.equal((await first).status, "succeeded");
  assert.equal((await createPresentation(outline, request, "actor-a", env, deps)).status, "already_run");
  assert.deepEqual(names, ["upload_new_file", "read_file"]); assert.equal(mock.generations(), 1);
});

test("partial upload errors retain a safe actual file ID without replay or raw output", async (t) => {
  const { env } = await fixture(t);
  for (const key of ["id", "file_id"] as const) {
    const mock = simulation(); let calls = 0;
    const deps = { ...mock.deps, clientFactory: () => ({ callTool: async (name: string) => {
      calls++; assert.equal(name, "upload_new_file");
      const error = new WpsError("UPSTREAM_ERROR", "WPS 未完整返回本次结果。", 502);
      error.partialResult = { code: 123, data: { [key]: "partially-created-77",
        link_url: FILE_URL + "?token=private-query", document_body: "must-not-return-body" } };
      throw error;
    } }) };
    const request = crypto.randomUUID();
    const result = await createPresentation(outline, request, "actor-a", env, deps);
    assert.ok("verification" in result);
    assert.equal(result.status, "uncertain"); assert.equal(result.fileId, "partially-created-77");
    assert.equal(result.url, undefined); assert.equal(result.verification.status, "not_run");
    assert.equal(result.error?.code, "UPSTREAM_ERROR");
    assert.doesNotMatch(JSON.stringify(result), /private-query|must-not-return-body|document_body/);
    assert.equal((await createPresentation(outline, request, "actor-a", env, deps)).status, "unknown_after_timeout");
    assert.equal(calls, 1);
  }
});

test("unrecognized or incomplete KDC results stay unverified and preserve the upload ID", async (t) => {
  const { env } = await fixture(t);
  const unsupported = [
    { ...kdc(), content_format: "markdown" },
    { ...kdc(), warnings: ["partial extraction"] },
    { file_id: FILE_ID, status: "ok", content_format: "kdc", content: {} },
  ];
  for (const data of unsupported) {
    const mock = simulation(() => json({ code: 0, data }));
    const result = await createPresentation(outline, crypto.randomUUID(), "actor-a", env, mock.deps);
    assert.ok("verification" in result);
    assert.equal(result.status, "uncertain"); assert.equal(result.fileId, FILE_ID);
    assert.equal(result.verification.status, "not_run"); assert.equal(mock.calls.length, 2);
  }
});

test("a read failure or changed connection cannot trigger a second upload", async (t) => {
  const { db, env } = await fixture(t);
  const mock = simulation(() => { throw new WpsError("UPSTREAM_TIMEOUT", "读取尚未返回。", 504); });
  const request = crypto.randomUUID();
  const result = await createPresentation(outline, request, "actor-a", env, mock.deps);
  assert.ok("verification" in result);
  assert.equal(result.status, "uncertain"); assert.equal(result.fileId, FILE_ID);
  assert.equal(result.verification.error?.code, "UPSTREAM_TIMEOUT");
  assert.equal((await createPresentation(outline, request, "actor-a", env, mock.deps)).status, "unknown_after_timeout");
  assert.equal(mock.calls.length, 2);

  let calls = 0;
  const changed = { ...mock.deps, clientFactory: () => ({ callTool: async (name: string) => {
    calls++; assert.equal(name, "upload_new_file");
    db.sqlite.prepare("UPDATE wps_connections SET connection_id='another-account' WHERE user_id='actor-a'").run();
    return json({ code: 0, data: { id: FILE_ID } });
  } }) };
  const stopped = await createPresentation(outline, crypto.randomUUID(), "actor-a", env, changed);
  assert.ok("verification" in stopped);
  assert.equal(stopped.status, "uncertain"); assert.equal(stopped.fileId, FILE_ID);
  assert.equal(stopped.verification.error?.code, "CONNECTION_CHANGED"); assert.equal(calls, 1);
});

test("invalid outlines and continuation IDs cause zero generator and WPS calls", async (t) => {
  const { db, env } = await fixture(t); const mock = simulation();
  for (const input of [
    { ...outline, slides: [] }, { ...outline, title: "../document" },
    { ...outline, slides: [{ title: "标题", bullets: ["文".repeat(61)] }] },
    { ...outline, url: "https://example.com/remote.pptx" },
    { ...outline, slides: [{ title: "标题", bullets: ["<script>active()</script>"] }] },
  ]) {
    await assert.rejects(createPresentation(input, crypto.randomUUID(), "actor-a", env, mock.deps), { code: "PRESENTATION_INPUT_INVALID" });
    await assert.rejects(verifyPresentation(input, FILE_ID, undefined, "actor-a", env, mock.deps), { code: "PRESENTATION_INPUT_INVALID" });
  }
  await assert.rejects(createPresentation(outline, "not-a-uuid", "actor-a", env, mock.deps), { code: "REQUEST_ID_REQUIRED" });
  await assert.rejects(verifyPresentation(outline, "https://example.com/a.pptx", undefined, "actor-a", env, mock.deps), { code: "PRESENTATION_ID_INVALID" });
  await assert.rejects(verifyPresentation(outline, FILE_ID, "../task", "actor-a", env, mock.deps), { code: "PRESENTATION_ID_INVALID" });
  assert.equal(mock.calls.length, 0); assert.equal(mock.generations(), 0);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM wps_executions").get()?.n, 0);
});
