import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import {
  activeCredential, actorFrom, AUTH_TTL, beginConnection, connectionStatus,
  pollConnection, requireSameOrigin, cancelConnection, importPersonalToken, verifyConnection, type RuntimeEnv,
} from "../lib/wps-auth.ts";
import { seal, unseal } from "../lib/wps-crypto.ts";
import { connectionCaller } from "../lib/wps-gateway.ts";
import { WpsStore } from "../lib/wps-store.ts";
import { executeTool } from "../lib/wps-tools.ts";
import { WpsError, type McpToolResult } from "../lib/wps-upstream.ts";

type BindValue = string | number | bigint | null | Uint8Array;
type Exchange = NonNullable<Parameters<typeof pollConnection>[3]>;
type ExchangeResult = Awaited<ReturnType<Exchange>>;
const TEST_KEY = "91".repeat(32);
const TEST_TOKEN = "test-only-wps-token-never-sent-to-network";
const jsonResult = (value: unknown): McpToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
// Official list_my_files / search_files envelopes. Empty items is also valid.
function listResult(empty = false): McpToolResult {
  return jsonResult({ code: 0, msg: "ok", data: { drive_id: "8001234567", parent_id: "0", drive_source: "special",
    items: empty ? [] : [{ id: "CmFqW8kR2nP5xL9vH3jT6aB1dE4gI7sM0", name: "测试目录", type: "folder", drive_id: "8001234567", parent_id: "0", mtime: 1710000000 }],
    next_page_token: "" } });
}
function searchResult(): McpToolResult {
  return jsonResult({ code: 0, msg: "ok", data: { items: [], next_page_token: "" } });
}
function defaultDriveError(nextActions: unknown = ["search_files", "read_file", "get_share_info"]) {
  const error = new WpsError("UPSTREAM_ERROR", "Default drive could not be resolved", 502, { businessCode: 400001 });
  error.partialResult = { code: 400001, data: { next_actions: nextActions } };
  return error;
}

// Exercise the production SQL against SQLite using the actual migration. The
// adapter implements only the D1 methods this authorization module uses.
class SqliteStatement {
  constructor(private db: DatabaseSync, private sql: string, private args: BindValue[] = []) {}
  bind(...args: BindValue[]) { return new SqliteStatement(this.db, this.sql, args); }
  async first<T>(): Promise<T | null> {
    return (this.db.prepare(this.sql).get(...this.args) as T | undefined) ?? null;
  }
  execute() {
    const result = this.db.prepare(this.sql).run(...this.args);
    return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
  }
  async run() { return this.execute(); }
}

class SqliteD1 {
  readonly sqlite = new DatabaseSync(":memory:");
  constructor() {
    this.sqlite.exec(readFileSync(new URL("../drizzle/0000_sturdy_mephisto.sql", import.meta.url), "utf8"));
  }
  prepare(sql: string) { return new SqliteStatement(this.sqlite, sql); }
  async batch(statements: SqliteStatement[]) {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => statement.execute());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
}

function fixture(t: TestContext) {
  const db = new SqliteD1();
  t.after(() => db.sqlite.close());
  const env: RuntimeEnv = {
    DB: db as unknown as D1Database, WPS_ENCRYPTION_KEY: TEST_KEY,
    SITE_ORIGIN: "https://bridge.example",
  };
  return { db, env, store: new WpsStore(env.DB!) };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test("begin → pending → connected → replay binds the code and stores only ciphertext", async (t) => {
  const { env, store } = fixture(t);
  let now = Date.now();
  const attempt = await beginConnection("actor-a", env, now);
  const officialUrl = new URL(attempt.authorizationUrl);
  assert.equal(officialUrl.origin, "https://mcp-center.wps.cn");
  assert.equal(officialUrl.pathname, "/kdocs-auth/auth-guide");
  const code = officialUrl.searchParams.get("auth_code")!;
  assert.match(code, /^[0-9a-f-]{36}$/);
  assert.notEqual(code, attempt.attemptId);
  assert.equal(attempt.expiresAt, now + AUTH_TTL);
  const pendingRow = (await store.getAttempt("actor-a"))!;
  assert.notEqual(pendingRow.code_cipher, code);
  assert.equal(await unseal({ cipher: pendingRow.code_cipher, iv: pendingRow.code_iv },
    TEST_KEY, "actor-a", `auth:${attempt.attemptId}`), code);
  await assert.rejects(beginConnection("actor-a", env, now + 1), { code: "TOO_MANY_ATTEMPTS" });

  let calls = 0;
  const exchange: Exchange = async (received) => {
    calls++;
    assert.equal(received, code);
    return calls === 1 ? { status: "pending" } : { status: "connected", token: TEST_TOKEN };
  };
  assert.equal((await pollConnection("actor-a", attempt.attemptId, env, exchange, () => now)).status, "pending");
  assert.equal((await pollConnection("actor-a", attempt.attemptId, env, exchange, () => now)).status, "pending");
  assert.equal(calls, 1, "poll rate limit must not make another upstream request");
  now += 2_001;
  assert.equal((await pollConnection("actor-a", attempt.attemptId, env, exchange, () => now)).status, "connected");
  assert.equal(await store.getAttempt("actor-a"), null);
  const connection = (await store.getConnection("actor-a"))!;
  assert.equal(connection.connection_id, attempt.attemptId);
  assert.notEqual(connection.token_cipher, TEST_TOKEN);
  assert.equal(connection.expires_at, null, "an absent lifetime remains explicitly unknown");
  assert.equal((await activeCredential("actor-a", env)).token, TEST_TOKEN);
  assert.equal((await connectionStatus("actor-a", env, now)).upstreamVerified, false);
  assert.equal((await pollConnection("actor-a", attempt.attemptId, env, exchange, () => now)).status, "connected");
  assert.equal(calls, 2, "a completed attempt must not exchange the code again");
  assert.equal(JSON.stringify(await connectionStatus("actor-a", env, now)).includes(TEST_TOKEN), false);
});

test("another actor cannot poll, read, or disconnect the owner's connection", async (t) => {
  const { env, store } = fixture(t);
  const now = Date.now();
  const attempt = await beginConnection("actor-a", env, now);
  let calls = 0;
  const exchange: Exchange = async () => { calls++; return { status: "connected", token: TEST_TOKEN }; };
  assert.equal((await pollConnection("actor-b", attempt.attemptId, env, exchange, () => now)).status, "expired");
  assert.equal(calls, 0);
  assert.equal((await store.getAttempt("actor-a"))?.attempt_id, attempt.attemptId);
  await pollConnection("actor-a", attempt.attemptId, env, exchange, () => now);
  await assert.rejects(activeCredential("actor-b", env), { code: "NOT_CONNECTED" });
  await store.disconnect("actor-b");
  assert.equal((await activeCredential("actor-a", env)).token, TEST_TOKEN);
});

test("a lease allows only one in-flight exchange for the same attempt", { timeout: 5_000 }, async (t) => {
  const { env } = fixture(t);
  const now = Date.now();
  const attempt = await beginConnection("actor-a", env, now);
  const entered = deferred<void>();
  const release = deferred<ExchangeResult>();
  let calls = 0;
  const exchange: Exchange = async () => { calls++; entered.resolve(); return release.promise; };
  const first = pollConnection("actor-a", attempt.attemptId, env, exchange, () => now);
  await entered.promise;
  assert.equal((await pollConnection("actor-a", attempt.attemptId, env, exchange, () => now + 3_000)).status, "pending");
  assert.equal(calls, 1);
  release.resolve({ status: "connected", token: TEST_TOKEN });
  assert.equal((await first).status, "connected");
});

test("disconnect during exchange cannot reconnect the user when the response arrives", { timeout: 5_000 }, async (t) => {
  const { env, store } = fixture(t);
  const now = Date.now();
  const attempt = await beginConnection("actor-a", env, now);
  const entered = deferred<void>();
  const release = deferred<ExchangeResult>();
  const exchange: Exchange = async () => { entered.resolve(); return release.promise; };
  const pending = pollConnection("actor-a", attempt.attemptId, env, exchange, () => now);
  await entered.promise;
  await store.disconnect("actor-a");
  release.resolve({ status: "connected", token: TEST_TOKEN });
  assert.equal((await pending).status, "expired");
  assert.equal(await store.getConnection("actor-a"), null);
  assert.equal(await store.getAttempt("actor-a"), null);
  assert.equal((await connectionStatus("actor-a", env, now)).connected, false);
});

test("starting a newer attempt invalidates an in-flight older exchange", { timeout: 5_000 }, async (t) => {
  const { env, store } = fixture(t);
  let now = Date.now();
  const oldAttempt = await beginConnection("actor-a", env, now);
  const entered = deferred<void>();
  const release = deferred<ExchangeResult>();
  const oldPoll = pollConnection("actor-a", oldAttempt.attemptId, env,
    async () => { entered.resolve(); return release.promise; }, () => now);
  await entered.promise;
  now += 5_001;
  const newAttempt = await beginConnection("actor-a", env, now);
  release.resolve({ status: "connected", token: "old-test-token" });
  assert.equal((await oldPoll).status, "expired");
  assert.equal(await store.getConnection("actor-a"), null);
  assert.equal((await store.getAttempt("actor-a"))?.attempt_id, newAttempt.attemptId);
  const connected = await pollConnection("actor-a", newAttempt.attemptId, env,
    async () => ({ status: "connected", token: TEST_TOKEN }), () => now);
  assert.equal(connected.status, "connected");
  assert.equal((await store.getConnection("actor-a"))?.connection_id, newAttempt.attemptId);
});

test("expired attempts stop without making an exchange request", async (t) => {
  const { env, store } = fixture(t);
  const now = Date.now();
  const attempt = await beginConnection("actor-a", env, now);
  const exchange: Exchange = async () => { assert.fail("expired authorization must not exchange"); };
  assert.equal((await pollConnection("actor-a", attempt.attemptId, env, exchange, () => attempt.expiresAt)).status, "expired");
  assert.equal(await store.getAttempt("actor-a"), null);
  assert.equal(await store.getConnection("actor-a"), null);
});

test("expiry during an in-flight exchange prevents saving the returned token", { timeout: 5_000 }, async (t) => {
  const { env, store } = fixture(t);
  let now = Date.now();
  const attempt = await beginConnection("actor-a", env, now);
  const entered = deferred<void>();
  const release = deferred<ExchangeResult>();
  const poll = pollConnection("actor-a", attempt.attemptId, env,
    async () => { entered.resolve(); return release.promise; }, () => now);
  await entered.promise;
  now = attempt.expiresAt + 1;
  release.resolve({ status: "connected", token: TEST_TOKEN });
  assert.equal((await poll).status, "expired");
  assert.equal(await store.getConnection("actor-a"), null);
});

test("known token lifetimes are enforced at the exact expiry boundary", async (t) => {
  const { env, store } = fixture(t);
  // Model a previously completed login while keeping the attempt within its TTL.
  const completedAt = Date.now() - 10_000;
  const attempt = await beginConnection("actor-a", env, completedAt);
  await pollConnection("actor-a", attempt.attemptId, env,
    async () => ({ status: "connected", token: TEST_TOKEN, expiresIn: 5 }), () => completedAt);
  const expiresAt = completedAt + 5_000;
  assert.equal((await store.getConnection("actor-a"))?.expires_at, expiresAt);
  assert.equal((await connectionStatus("actor-a", env, expiresAt - 1)).connected, true);
  assert.equal((await connectionStatus("actor-a", env, expiresAt)).status, "expired");
  await assert.rejects(activeCredential("actor-a", env), { code: "WPS_AUTH_EXPIRED" });
});

test("an explicitly nonpositive token lifetime never becomes an unlimited connection", async (t) => {
  const { env, store } = fixture(t);
  const now = Date.now();
  for (const expiresIn of [0, -1]) {
    const actor = `actor-expiry-${expiresIn}`;
    const attempt = await beginConnection(actor, env, now);
    const result = await pollConnection(actor, attempt.attemptId, env,
      async () => ({ status: "connected", token: TEST_TOKEN, expiresIn }), () => now);
    assert.equal(result.status, "expired");
    assert.equal(await store.getConnection(actor), null);
    assert.equal(await store.getAttempt(actor), null);
    await assert.rejects(activeCredential(actor, env), { code: "NOT_CONNECTED" });
  }
});

test("cancelled attempts cannot be replayed into a connection", async (t) => {
  const { env, store } = fixture(t);
  const now = Date.now();
  const attempt = await beginConnection("actor-a", env, now);
  let calls = 0;
  const exchange: Exchange = async () => { calls++; return { status: "cancelled" }; };
  assert.equal((await pollConnection("actor-a", attempt.attemptId, env, exchange, () => now)).status, "cancelled");
  assert.equal((await pollConnection("actor-a", attempt.attemptId, env, exchange, () => now + 3_000)).status, "expired");
  assert.equal(calls, 1);
  assert.equal(await store.getConnection("actor-a"), null);
});

test("an exchange error releases its lease so a bounded later poll can proceed", async (t) => {
  const { env, store } = fixture(t);
  let now = Date.now();
  const attempt = await beginConnection("actor-a", env, now);
  await assert.rejects(pollConnection("actor-a", attempt.attemptId, env,
    async () => { throw new Error("mock upstream unavailable"); }, () => now), /mock upstream unavailable/);
  assert.equal((await store.getAttempt("actor-a"))?.lease_id, null);
  now += 2_001;
  assert.equal((await pollConnection("actor-a", attempt.attemptId, env,
    async () => ({ status: "connected", token: TEST_TOKEN }), () => now)).status, "connected");
});

test("credential encryption rejects another actor, purpose, key, and tampered ciphertext", async () => {
  const encrypted = await seal(TEST_TOKEN, TEST_KEY, "actor-a", "token");
  assert.equal(await unseal(encrypted, TEST_KEY, "actor-a", "token"), TEST_TOKEN);
  await assert.rejects(unseal(encrypted, TEST_KEY, "actor-b", "token"), { code: "CREDENTIAL_UNAVAILABLE" });
  await assert.rejects(unseal(encrypted, TEST_KEY, "actor-a", "auth:another-attempt"), { code: "CREDENTIAL_UNAVAILABLE" });
  await assert.rejects(unseal(encrypted, "92".repeat(32), "actor-a", "token"), { code: "CREDENTIAL_UNAVAILABLE" });
  const tampered = { ...encrypted, cipher: (encrypted.cipher.startsWith("A") ? "B" : "A") + encrypted.cipher.slice(1) };
  await assert.rejects(unseal(tampered, TEST_KEY, "actor-a", "token"), { code: "CREDENTIAL_UNAVAILABLE" });
});

test("browser writes require the configured origin and a valid injected actor", () => {
  const env: RuntimeEnv = { SITE_ORIGIN: "https://bridge.example" };
  const request = (headers: Record<string, string>) => new Request("https://bridge.example/api/wps/connect", { method: "POST", headers });
  const trusted = { origin: "https://bridge.example", "oai-authenticated-user-id": "actor-a" };
  assert.equal(actorFrom(request(trusted)), "actor-a");
  assert.doesNotThrow(() => requireSameOrigin(request(trusted), env));
  assert.throws(() => requireSameOrigin(request({ ...trusted, origin: "https://other.example" }), env), { code: "ORIGIN_REJECTED" });
  assert.throws(() => requireSameOrigin(request({ "oai-authenticated-user-id": "actor-a" }), env), { code: "ORIGIN_REJECTED" });
  assert.throws(() => requireSameOrigin(request({ ...trusted, "sec-fetch-site": "cross-site" }), env), { code: "ORIGIN_REJECTED" });
  assert.throws(() => actorFrom(request({ origin: trusted.origin })), { code: "SIGN_IN_REQUIRED" });
  assert.throws(() => actorFrom(request({ ...trusted, "oai-authenticated-user-id": "actor a" })), { code: "SIGN_IN_REQUIRED" });
  assert.throws(() => actorFrom(request({ ...trusted, "oai-authenticated-user-id": "a".repeat(257) })), { code: "SIGN_IN_REQUIRED" });
});

test("page reload resumes only the caller's pending attempt; MCP status never returns the auth URL", async (t) => {
  const { env } = fixture(t);
  const now = Date.now();
  const attempt = await beginConnection("actor-a", env, now);
  assert.deepEqual((await connectionStatus("actor-a", env, now + 1_000, true)).pending, attempt);
  assert.equal((await connectionStatus("actor-a", env, now + 1_000)).pending, undefined);
  assert.equal((await connectionStatus("actor-b", env, now + 1_000, true)).pending, undefined);
  assert.equal((await connectionStatus("actor-a", env, attempt.expiresAt, true)).pending, undefined);
});

test("browser cancellation invalidates pending exchange but cannot cancel another user's attempt", async (t) => {
  const { env, store } = fixture(t);
  const attempt = await beginConnection("actor-a", env);
  await cancelConnection("actor-b", attempt.attemptId, env);
  assert.notEqual(await store.getAttempt("actor-a"), null);
  await cancelConnection("actor-a", attempt.attemptId, env);
  assert.equal(await store.getAttempt("actor-a"), null);
  assert.equal((await pollConnection("actor-a", attempt.attemptId, env, async () => {
    assert.fail("cancelled attempt must not exchange");
  })).status, "expired");
});

test("manual personal token is verified by a business read before encrypted storage, never echoed", async (t) => {
  const { env, store } = fixture(t);
  let calls = 0;
  const factory = (token: string) => ({ callTool: async (name: string, args: Record<string, unknown>) => {
    calls++;
    assert.equal(token, TEST_TOKEN);
    assert.equal(name, "list_my_files");
    assert.deepEqual(args, { page_size: 1 });
    assert.equal(await store.getConnection("actor-a"), null);
    return listResult();
  } });
  const status = await importPersonalToken("actor-a", `  ${TEST_TOKEN}  `, env, factory);
  assert.equal(calls, 1);
  assert.equal(status.connected, true);
  assert.equal(status.upstreamVerified, true);
  assert.equal(JSON.stringify(status).includes(TEST_TOKEN), false);
  assert.equal((await activeCredential("actor-a", env)).token, TEST_TOKEN);
  assert.equal(await store.getAttempt("actor-a"), null);
});

test("a rejected manual token cannot create a connection", async (t) => {
  const { env, store } = fixture(t);
  await assert.rejects(importPersonalToken("actor-a", TEST_TOKEN, env, () => ({
    callTool: async () => ({ isError: true, content: [{ type: "text", text: "denied" }] }),
  })), { code: "WPS_VALIDATION_FAILED" });
  assert.equal(await store.getConnection("actor-a"), null);
  assert.equal(await store.getAttempt("actor-a"), null);
});

test("disconnect during manual validation prevents stale credential storage", async (t) => {
  const { env, store } = fixture(t);
  await assert.rejects(importPersonalToken("actor-a", TEST_TOKEN, env, () => ({ callTool: async () => {
    await store.disconnect("actor-a");
    return listResult();
  } })), { code: "CONNECTION_CHANGED" });
  assert.equal(await store.getConnection("actor-a"), null);
});

test("verification marks an expired credential without falsely reporting business access", async (t) => {
  const { env } = fixture(t);
  const attempt = await beginConnection("actor-a", env);
  await pollConnection("actor-a", attempt.attemptId, env, async () => ({ status: "connected", token: TEST_TOKEN }));
  await assert.rejects(verifyConnection("actor-a", env, () => ({ callTool: async () => {
    throw new WpsError("WPS_AUTH_EXPIRED", "expired", 401);
  } })), { code: "WPS_AUTH_EXPIRED" });
  const status = await connectionStatus("actor-a", env);
  assert.equal(status.status, "expired");
  assert.equal(status.upstreamVerified, false);
});

test("verification cannot claim success for a different connection selected during the request", async (t) => {
  const { env, store } = fixture(t);
  const attempt = await beginConnection("actor-a", env);
  await pollConnection("actor-a", attempt.attemptId, env, async () => ({ status: "connected", token: TEST_TOKEN }));
  await assert.rejects(verifyConnection("actor-a", env, () => ({ callTool: async () => {
    await store.disconnect("actor-a");
    return listResult();
  } })), { code: "CONNECTION_CHANGED" });
  assert.equal((await connectionStatus("actor-a", env)).connected, false);
});

test("a valid empty personal root list is sufficient authenticated read evidence", async (t) => {
  const { env, store } = fixture(t);
  const status = await importPersonalToken("actor-a", TEST_TOKEN, env, () => ({ callTool: async () => listResult(true) }));
  assert.equal(status.upstreamVerified, true);
  assert.ok((await store.getConnection("actor-a"))?.verified_at);
});

test("valid empty final pages may omit pagination and optional drive metadata", async (t) => {
  const { env, store } = fixture(t);
  for (const useFallback of [false, true]) {
    const actor = useFallback ? "empty-search-page" : "empty-root-page";
    let calls = 0;
    const status = await importPersonalToken(actor, TEST_TOKEN, env, () => ({ callTool: async (name) => {
      calls++;
      if (useFallback && name === "list_my_files") throw defaultDriveError();
      return jsonResult({ code: 0, data: { items: [] } });
    } }));
    assert.equal(status.upstreamVerified, true);
    assert.equal(calls, useFallback ? 2 : 1);
    assert.ok((await store.getConnection(actor))?.verified_at);
  }
});

test("only the documented default-drive error permits one fixed filename search fallback", async (t) => {
  const { env, store } = fixture(t);
  for (const [index, actions] of [
    ["search_files", "read_file"],
    [{ tool: "search_files", arguments: { keyword: "must-not-use-this", type: "content", page_size: 500 } }],
  ].entries()) {
    const actor = "fallback-actor-" + index;
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    let factories = 0;
    const status = await importPersonalToken(actor, TEST_TOKEN, env, () => {
      factories++;
      return { callTool: async (name, args) => {
        calls.push({ name, args });
        assert.equal(await store.getConnection(actor), null, "no credential is stored before validated search success");
        if (name === "list_my_files") throw defaultDriveError(actions);
        return searchResult();
      } };
    });
    assert.equal(status.upstreamVerified, true); assert.equal(factories, 1);
    assert.deepEqual(calls, [
      { name: "list_my_files", args: { page_size: 1 } },
      { name: "search_files", args: { keyword: "__wps_connection_probe_7fd6b942_95df_4c31_a01c_6ea8f6d873b2__", type: "file_name", page_size: 1 } },
    ]);
    assert.equal(JSON.stringify(status).includes(TEST_TOKEN), false);
  }
});

test("unknown success envelopes never store or mark a credential verified, and do not trigger fallback", async (t) => {
  const { env, store } = fixture(t);
  const cases: McpToolResult[] = [
    { content: [{ type: "text", text: "OK" }] }, jsonResult([]), jsonResult({ code: 0, data: {} }),
    jsonResult({ code: 0, data: { drive_id: "drive", parent_id: "0", drive_source: "special", next_page_token: "", items: [{}] } }),
    { content: [listResult().content[0], listResult().content[0]] },
  ];
  for (const [index, response] of cases.entries()) {
    const actor = "unknown-actor-" + index; let calls = 0;
    await assert.rejects(importPersonalToken(actor, TEST_TOKEN, env, () => ({ callTool: async () => { calls++; return response; } })), { code: "WPS_VALIDATION_FAILED" });
    assert.equal(calls, 1); assert.equal(await store.getConnection(actor), null); assert.equal(await store.getAttempt(actor), null);
  }
  const attempt = await beginConnection("existing-actor", env);
  await pollConnection("existing-actor", attempt.attemptId, env, async () => ({ status: "connected", token: TEST_TOKEN }));
  await assert.rejects(verifyConnection("existing-actor", env, () => ({ callTool: async () => jsonResult([]) })), { code: "WPS_VALIDATION_FAILED" });
  assert.equal((await store.getConnection("existing-actor"))?.verified_at, null);
});

test("a default-drive error without an exact search recommendation never falls back", async (t) => {
  const { env, store } = fixture(t);
  const errors = [defaultDriveError([]), defaultDriveError(["read_file"]), defaultDriveError(["please call search_files"]),
    defaultDriveError({ arbitrary: "search_files" }), new WpsError("UPSTREAM_ERROR", "not default drive", 502, { businessCode: 400100 })];
  for (const [index, error] of errors.entries()) {
    const actor = "no-fallback-" + index; let calls = 0;
    await assert.rejects(importPersonalToken(actor, TEST_TOKEN, env, () => ({ callTool: async () => { calls++; throw error; } })), (caught) => caught === error);
    assert.equal(calls, 1); assert.equal(await store.getConnection(actor), null);
  }
});

test("401, 403, 429 and transport errors cannot use the search fallback", async (t) => {
  const { env, store } = fixture(t);
  const errors = [
    new WpsError("WPS_AUTH_EXPIRED", "expired", 401, { businessCode: 400001 }),
    new WpsError("WPS_FORBIDDEN", "forbidden", 403, { businessCode: 400001 }),
    new WpsError("WPS_RATE_LIMITED", "limited", 429, { businessCode: 400001 }),
    new WpsError("UPSTREAM_TIMEOUT", "timeout", 504, { businessCode: 400001 }),
    new WpsError("UPSTREAM_ERROR", "network", 502, { stage: "fetch" }),
    new WpsError("UPSTREAM_ERROR", "HTTP unauthorized", 502, { httpStatus: 401, businessCode: 400001 }),
  ];
  for (const [index, error] of errors.entries()) {
    error.partialResult = { code: 400001, data: { next_actions: ["search_files"] } };
    const actor = "blocked-fallback-" + index; let calls = 0;
    await assert.rejects(importPersonalToken(actor, TEST_TOKEN, env, () => ({ callTool: async () => { calls++; throw error; } })), (caught) => caught === error);
    assert.equal(calls, 1); assert.equal(await store.getConnection(actor), null);
  }
});

test("fallback search must itself return a valid search list and never retries", async (t) => {
  const { env, store } = fixture(t);
  for (const [index, response] of [jsonResult({ code: 0, data: { items: [{}], next_page_token: "" } }), listResult()].entries()) {
    const actor = "invalid-search-" + index; const names: string[] = [];
    await assert.rejects(importPersonalToken(actor, TEST_TOKEN, env, () => ({ callTool: async (name) => {
      names.push(name); if (names.length === 1) throw defaultDriveError(); return response;
    } })), { code: "WPS_VALIDATION_FAILED" });
    assert.deepEqual(names, ["list_my_files", "search_files"]); assert.equal(await store.getConnection(actor), null);
  }
  let calls = 0;
  await assert.rejects(importPersonalToken("search-error", TEST_TOKEN, env, () => ({ callTool: async () => {
    calls++; throw defaultDriveError();
  } })), { code: "UPSTREAM_ERROR" });
  assert.equal(calls, 2); assert.equal(await store.getConnection("search-error"), null);
});

test("ordinary gateway and convenience calls cannot set the account verification timestamp", async (t) => {
  const { env, store } = fixture(t);
  const attempt = await beginConnection("actor-a", env);
  await pollConnection("actor-a", attempt.attemptId, env, async () => ({ status: "connected", token: TEST_TOKEN }));
  const factory = () => ({ callTool: async () => jsonResult({ code: 0, data: {} }) });
  const caller = await connectionCaller("actor-a", env, { clientFactory: factory });
  await caller.callTool("check_skill_update", {});
  await executeTool("wps_file_info", { file_id: "ordinary-file" }, "actor-a", env, factory);
  assert.equal((await store.getConnection("actor-a"))?.verified_at, null);
  assert.equal((await connectionStatus("actor-a", env)).upstreamVerified, false);
  await verifyConnection("actor-a", env, () => ({ callTool: async () => listResult() }));
  assert.equal((await connectionStatus("actor-a", env)).upstreamVerified, true);
});
