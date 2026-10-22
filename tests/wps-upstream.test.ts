import test from "node:test";
import assert from "node:assert/strict";
import { WpsMcpClient, WpsError, exchangeWpsCode } from "../lib/wps-upstream.ts";

const TOKEN = "test-wps-secret-value";
const CODE = "7a0d46b2-6a6c-4a57-9da3-57e2c39732cb";
type Call = { url: string; init: RequestInit; body: Record<string, unknown>; headers: Headers };

function json(value: unknown, status = 200, headers?: Record<string, string>) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json", ...headers } });
}

function rpc(call: Call, result: unknown, headers?: Record<string, string>) {
  return json({ jsonrpc: "2.0", id: call.body.id, result }, 200, headers);
}

function harness(handler: (call: Call, calls: Call[]) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(input), init: init ?? {}, body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers),
    };
    calls.push(call);
    if (call.body.method === "initialize") {
      return rpc(call, { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "fake", version: "1" } },
        { "mcp-session-id": "session-initial" });
    }
    if (call.body.method === "notifications/initialized") return new Response(null, { status: 202 });
    return handler(call, calls);
  }) as typeof fetch;
  return { calls, fetchImpl, client: new WpsMcpClient(TOKEN, fetchImpl) };
}

function success(text = "OK") { return { content: [{ type: "text", text }] }; }

test("uses fixed HTTPS endpoint, own identity, unique ids, per-instance session and one initialization", async () => {
  const first = harness((call) => rpc(call, success(), { "mcp-session-id": "session-rotated" }));
  await Promise.all([
    first.client.callTool("list_my_files", {}),
    first.client.callTool("sheet.get_range_data", { worksheet_id: 17 }),
  ]);
  await first.client.callTool("get_file_info", { file_id: "file" });
  assert.equal(first.calls.filter((c) => c.body.method === "initialize").length, 1);
  assert.equal(first.calls.filter((c) => c.body.method === "notifications/initialized").length, 1);
  const ids = first.calls.filter((c) => "id" in c.body).map((c) => c.body.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal("id" in first.calls[1].body, false);
  assert.equal(first.calls[1].headers.get("mcp-session-id"), "session-initial");
  assert.equal(first.calls.at(-1)!.headers.get("mcp-session-id"), "session-rotated");
  for (const call of first.calls) {
    assert.equal(call.url, "https://mcp-center.wps.cn/skill_hub/mcp");
    assert.equal(call.headers.get("authorization"), `Bearer ${TOKEN}`);
    assert.equal(call.headers.get("x-request-source"), "wps-cloud-bridge/0.8.1");
    assert.equal(call.headers.get("user-agent"), "wps-cloud-bridge/0.8.1");
    assert.equal(call.headers.get("x-skill-version"), "1.0.0");
    assert.equal(call.init.redirect, "manual");
    assert.equal(call.init.credentials, "omit");
  }
  assert.deepEqual(first.calls[3].body.params, { name: "sheet.get_range_data", arguments: { worksheet_id: 17 } });
  const second = harness((call) => rpc(call, success()));
  await second.client.callTool("list_my_files", {});
  assert.equal(second.calls[0].headers.has("mcp-session-id"), false);
});

test("rejects an absent credential before any request", () => {
  let calls = 0;
  const fetchImpl = (() => { calls++; throw new Error("must not fetch"); }) as typeof fetch;
  for (const token of ["", "   ", "x\r\ny"]) {
    assert.throws(() => new WpsMcpClient(token, fetchImpl), { code: "WPS_AUTH_EXPIRED" });
  }
  assert.equal(calls, 0);
});

test("reads all tools/list cursor pages and preserves raw tool names", async () => {
  const { client, calls } = harness((call) => {
    const params = call.body.params as Record<string, unknown>;
    return rpc(call, params.cursor ? {
      tools: [{ name: "sheet.range_data_batch_update", inputSchema: { type: "object", required: ["range_data"] } }],
    } : {
      tools: [{ name: "wps.texts.replace", inputSchema: { type: "object" } }], nextCursor: "next-page-cursor",
    });
  });
  const tools = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name), ["wps.texts.replace", "sheet.range_data_batch_update"]);
  assert.deepEqual(calls[2].body.params, {});
  assert.deepEqual(calls[3].body.params, { cursor: "next-page-cursor" });
});

test("does not return a partial tool list on a repeated pagination cursor", async () => {
  let page = 0;
  const { client } = harness((call) => rpc(call, {
    tools: [{ name: `tool_${page++}`, inputSchema: { type: "object" } }], nextCursor: "repeated",
  }));
  await assert.rejects(client.listTools(), { code: "UPSTREAM_INVALID_RESPONSE" });
});

test("classifies HTTP failures without exposing an upstream body or token", async () => {
  for (const [status, code] of [[401, "WPS_AUTH_EXPIRED"], [403, "WPS_FORBIDDEN"], [429, "WPS_RATE_LIMITED"], [503, "UPSTREAM_ERROR"]] as const) {
    const { client, calls } = harness(() => new Response(`Authorization: Bearer ${TOKEN}`, { status }));
    await assert.rejects(client.callTool("wps.texts.replace", { find_text: "a", replace_text: "b" }), (error: unknown) => {
      assert.ok(error instanceof WpsError);
      assert.equal(error.code, code);
      assert.equal(error.message.includes(TOKEN), false);
      return true;
    });
    assert.equal(calls.filter((call) => call.body.method === "tools/call").length, 1, "writes must never be automatically retried");
  }
});

test("detects HTTP 400 business-expiration envelopes", async () => {
  const { client } = harness(() => json({ code: 400006, msg: "expired", data: null }, 400));
  await assert.rejects(client.callTool("read_file", { file_id: "a" }), { code: "WPS_AUTH_EXPIRED" });
});

test("detects JSON-RPC errors and rejects mismatched response ids", async () => {
  const error = harness((call) => json({ jsonrpc: "2.0", id: call.body.id, error: { code: 403, message: TOKEN } }));
  await assert.rejects(error.client.callTool("read_file", {}), { code: "WPS_FORBIDDEN" });
  const mismatch = harness(() => json({ jsonrpc: "2.0", id: 999, result: success() }));
  await assert.rejects(mismatch.client.callTool("read_file", {}), { code: "UPSTREAM_INVALID_RESPONSE" });
});

test("detects business errors at content and structured roots", async () => {
  for (const result of [
    success(JSON.stringify({ code: 400006, data: null, msg: "authorization expired" })),
    { ...success(), structuredContent: { code: "400006", message: "expired" } },
    { code: 400006, result: null },
  ]) {
    const { client } = harness((call) => rpc(call, result));
    await assert.rejects(client.callTool("read_file", {}), { code: "WPS_AUTH_EXPIRED" });
  }
});

test("does not interpret arbitrary document code fields or nested JSON as errors", async () => {
  const business = {
    code: 0, msg: "success",
    data: { code: 403, msg: "this is document content", content: JSON.stringify({ code: 400006, message: "an example" }) },
  };
  const result = { content: [
    { type: "text", text: JSON.stringify(business) },
    { type: "text", text: JSON.stringify({ code: 403, description: "a document field without an envelope" }) },
  ], structuredContent: { data: { code: 401, msg: "a quoted error in a document" } } };
  const { client } = harness((call) => rpc(call, result));
  assert.deepEqual(await client.callTool("read_file", {}), result);
});

test("redacts exact credentials and sensitive keys recursively while preserving pagination cursors", async () => {
  const original = {
    code: 0,
    data: {
      title: `document containing ${TOKEN}`,
      access_token: "different-secret",
      Authorization: "Bearer a-second-secret",
      nested: [{ refresh_token: "refresh-secret", page_token: "page-one", next_page_token: "page-two" }],
      embedded: JSON.stringify({ access_token: "embedded-secret", page_token: "page-three" }),
    },
  };
  const { client } = harness((call) => rpc(call, {
    content: [{ type: "text", text: JSON.stringify(original) }, { type: "text", text: `plain text ${TOKEN}` }],
    structuredContent: { authorization: "Bearer third-secret", document: { text: TOKEN }, page_token: "page-four" },
  }));
  const result = await client.callTool("read_file", {});
  const text = JSON.stringify(result);
  for (const secret of [TOKEN, "different-secret", "a-second-secret", "refresh-secret", "embedded-secret", "third-secret"]) {
    assert.equal(text.includes(secret), false);
  }
  for (const cursor of ["page-one", "page-two", "page-three", "page-four"]) assert.equal(text.includes(cursor), true);
  assert.match(text, /已隐藏凭据/);
});

test("preserves MCP isError and structuredContent instead of claiming success", async () => {
  const expected = { ...success("document operation failed"), isError: true, structuredContent: { reason: "unsupported" } };
  const { client } = harness((call) => rpc(call, expected));
  assert.deepEqual(await client.callTool("wps.texts.replace", {}), expected);
});

test("preserves unexpected non-text content as labelled JSON without dropping it", async () => {
  const { client } = harness((call) => rpc(call, { content: [{ type: "resource", resource: { uri: "wps://example", text: "document", access_token: "secret" } }] }));
  const result = await client.callTool("read_file", {});
  assert.match(result.content[0].text, /resource 内容（JSON）/);
  assert.match(result.content[0].text, /wps:\/\/example/);
  assert.equal(result.content[0].text.includes('"secret"'), false);
});

test("SSE returns on the matching id and cancels an otherwise endless stream", { timeout: 1_500 }, async () => {
  let cancelled = false;
  const encoder = new TextEncoder();
  const { client } = harness((call) => {
    const reply = JSON.stringify({ jsonrpc: "2.0", id: call.body.id, result: success("流式结果") });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(': keepalive\r\ndata: {"jsonrpc":"2.0","method":"notifications/message"}\r\n\r'));
        controller.enqueue(encoder.encode(`\ndata: {"jsonrpc":"2.0","id":999,"result":{}}\n\ndata: ${reply}\r`));
        controller.enqueue(encoder.encode("\n\r\n"));
        // Deliberately stay open: a successful response must not wait for EOF.
      },
      cancel() { cancelled = true; return new Promise<void>(() => {}); },
    });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
  });
  assert.deepEqual(await client.callTool("read_file", {}), success("流式结果"));
  assert.equal(cancelled, true);
});

test("SSE handles multiline data and UTF-8 chunk boundaries", async () => {
  const encoder = new TextEncoder();
  const { client } = harness((call) => {
    const encoded = encoder.encode(`data: {"jsonrpc":"2.0","id":${call.body.id},\ndata: "result":{"content":[{"type":"text","text":"中文"}]}}\n\n`);
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < encoded.length; index += 3) controller.enqueue(encoded.slice(index, index + 3));
        controller.close();
      },
    }), { headers: { "Content-Type": "text/event-stream" } });
  });
  assert.deepEqual(await client.callTool("read_file", {}), success("中文"));
});

test("rejects an oversized body explicitly instead of returning truncated success", async () => {
  const { client } = harness(() => new Response("x".repeat(4 * 1024 * 1024 + 1)));
  await assert.rejects(client.callTool("read_file", {}), (error: unknown) => {
    assert.ok(error instanceof WpsError);
    assert.equal(error.code, "UPSTREAM_TOO_LARGE");
    assert.match(error.message, /未完整读取/);
    return true;
  });
});

test("body reads obey the 25-second timeout even if a producer ignores abort", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let startRead!: () => void;
  const entered = new Promise<void>((resolve) => { startRead = resolve; });
  let cancelled = false;
  const { client } = harness(() => new Response(new ReadableStream<Uint8Array>({
    pull() { startRead(); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 }), { headers: { "Content-Type": "application/json" } }));
  const rejected = assert.rejects(client.callTool("read_file", {}), { code: "UPSTREAM_TIMEOUT", status: 504 });
  await entered;
  t.mock.timers.tick(25_000);
  await rejected;
  assert.equal(cancelled, true);
});

test("network errors never expose credentials or implementation error messages", async () => {
  const { client } = harness(() => { throw new Error(`request Authorization: Bearer ${TOKEN}`); });
  await assert.rejects(client.callTool("wps.texts.replace", {}), (error: unknown) => {
    assert.ok(error instanceof WpsError);
    assert.equal(error.code, "UPSTREAM_ERROR");
    assert.equal(error.message.includes(TOKEN), false);
    assert.equal(error.message.includes("Authorization"), false);
    return true;
  });
});

function exchangeWith(value: unknown, status = 200, inspect?: (call: Call) => void) {
  return exchangeWpsCode(CODE, (async (input: string | URL | Request, init?: RequestInit) => {
    inspect?.({ url: String(input), init: init ?? {}, body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
    return json(value, status);
  }) as typeof fetch);
}

test("authorization exchange uses the fixed endpoint and exact code body without a bearer token", async () => {
  const result = await exchangeWith({ code: 200, token: TOKEN, expires_in: 3600 }, 200, (call) => {
    assert.equal(call.url, "https://api.wps.cn/office/v5/ai/skill_hub/wps_auth/exchange");
    assert.deepEqual(call.body, { code: CODE });
    assert.equal(call.headers.has("authorization"), false);
    assert.equal(call.init.redirect, "manual");
  });
  assert.deepEqual(result, { status: "connected", token: TOKEN, expiresIn: 3600 });
});

test("authorization exchange supports nested success, pending and cancellation envelopes", async () => {
  assert.deepEqual(await exchangeWith({ code: 0, data: { code: 200, token: TOKEN } }), { status: "connected", token: TOKEN });
  assert.deepEqual(await exchangeWith({ code: 202 }), { status: "pending" });
  assert.deepEqual(await exchangeWith({ data: { code: 409 } }), { status: "cancelled" });
  assert.deepEqual(await exchangeWith({}, 409), { status: "cancelled" });
  await assert.rejects(exchangeWith({ code: 200 }), { code: "UPSTREAM_INVALID_RESPONSE" });
  await assert.rejects(exchangeWith({ unexpected: true }), { code: "UPSTREAM_INVALID_RESPONSE" });
});

test("authorization exchange preserves explicit zero or negative expiry instead of making it unknown", async () => {
  for (const expiresIn of [0, -10]) {
    assert.deepEqual(await exchangeWith({ code: 200, token: TOKEN, expires_in: expiresIn }), {
      status: "connected", token: TOKEN, expiresIn,
    });
  }
});

test("authorization exchange makes enterprise, rate and server failures explicit", async () => {
  await assert.rejects(exchangeWith({ data: { code: 403001 } }), { code: "WPS_PERSONAL_ACCOUNT_REQUIRED", status: 403 });
  await assert.rejects(exchangeWith({ code: 403 }), { code: "WPS_FORBIDDEN", status: 403 });
  await assert.rejects(exchangeWith({}, 403), { code: "WPS_FORBIDDEN", status: 403 });
  await assert.rejects(exchangeWith({}, 429), { code: "WPS_RATE_LIMITED", status: 429 });
  await assert.rejects(exchangeWith({}, 503), { code: "UPSTREAM_ERROR", status: 502 });
  await assert.rejects(exchangeWith({ code: 429001 }), { code: "WPS_RATE_LIMITED" });
});

test("every redirect is rejected without following or exposing its target", async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    let calls = 0;
    const transport = (async (_input: unknown, init?: RequestInit) => {
      calls++;
      assert.equal(init?.redirect, "manual");
      return new Response(null, { status, headers: { location: `https://untrusted.example/${TOKEN}` } });
    }) as typeof fetch;
    await assert.rejects(exchangeWpsCode(CODE, transport), (error: unknown) => {
      assert.ok(error instanceof WpsError);
      assert.equal(error.code, "UPSTREAM_REDIRECT_REJECTED");
      assert.equal(error.diagnostic.httpStatus, status);
      assert.equal(error.retryable, false);
      assert.equal(JSON.stringify(error).includes(TOKEN), false);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test("unknown authorization codes are explicit errors rather than an endless pending state", async () => {
  await assert.rejects(exchangeWith({ code: 498, message: TOKEN }), (error: unknown) => {
    assert.ok(error instanceof WpsError);
    assert.equal(error.code, "WPS_AUTH_REJECTED");
    assert.equal(error.retryable, false);
    assert.equal(error.diagnostic.businessCode, 498);
    assert.equal(error.message.includes(TOKEN), false);
    return true;
  });
});

test("fetch and invalid JSON diagnostics retain only bounded non-secret scalars", async () => {
  await assert.rejects(exchangeWpsCode(CODE, (async () => {
    throw new TypeError(`network failed: ${TOKEN} ${CODE}`);
  }) as typeof fetch), (error: unknown) => {
    assert.ok(error instanceof WpsError);
    assert.equal(error.diagnostic.stage, "fetch");
    assert.equal(error.diagnostic.errorName, "TypeError");
    assert.equal(error.retryable, true);
    assert.equal(JSON.stringify(error).includes(TOKEN), false);
    assert.equal(JSON.stringify(error).includes(CODE), false);
    return true;
  });
  await assert.rejects(exchangeWpsCode(CODE, (async () =>
    new Response(`<html>${TOKEN}</html>`, { headers: { "content-type": "text/html" } })) as typeof fetch),
    (error: unknown) => {
      assert.ok(error instanceof WpsError);
      assert.equal(error.diagnostic.stage, "json");
      assert.equal(error.diagnostic.contentType, "html");
      assert.equal(error.diagnostic.httpStatus, 200);
      assert.equal(JSON.stringify(error).includes(TOKEN), false);
      return true;
    });
});

test("a business failure preserves already-created file IDs while redacting credentials", async () => {
  const failed = harness((call) => rpc(call, { content: [{ type: "text", text: JSON.stringify({
    code: 11000, msg: "formatting failed", data: { file_id: "created-file-123", token: TOKEN },
    param_detail: { step: "format", advice: `inspect the file; ${TOKEN}` },
  }) }] }));
  await assert.rejects(failed.client.callTool("create_file_with_content", {}), (error: unknown) => {
    assert.ok(error instanceof WpsError);
    assert.equal((error.partialResult?.data as Record<string, unknown>)?.file_id, "created-file-123");
    assert.equal(error.diagnostic.businessCode, 11000);
    assert.equal(JSON.stringify(error).includes(TOKEN), false);
    return true;
  });
});
