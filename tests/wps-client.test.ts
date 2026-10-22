import assert from "node:assert/strict";
import test from "node:test";
import { ApiError, apiRequest, checkedAttempt, newRequestId, retryDelay, safeDiagnostic, schemaExample } from "../app/components/wps-client.ts";

const authCode = "11111111-1111-4111-8111-111111111111";
const attempt = { attemptId: "22222222-2222-4222-8222-222222222222", authorizationUrl: `https://mcp-center.wps.cn/kdocs-auth/auth-guide?auth_code=${authCode}`, expiresAt: 1_800_000_000 };
const responseFetch = (body: unknown, status = 200): typeof fetch => (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as typeof fetch;

test("request IDs use 16 secure random bytes without requiring randomUUID", () => {
  let calls = 0;
  const randomSource: Pick<Crypto, "getRandomValues"> = {
    getRandomValues<T extends ArrayBufferView | null>(array: T): T {
      assert.equal(this, randomSource);
      assert.ok(array instanceof Uint8Array);
      assert.equal(array.length, 16);
      calls++;
      array.set(Array.from({ length: 16 }, (_, index) => index + 0xf0));
      return array;
    },
  };
  const id = newRequestId(randomSource);
  assert.equal(calls, 1);
  assert.equal(id, "f0f1f2f3-f4f5-46f7-b8f9-fafbfcfdfeff");
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("request IDs fail safely when secure entropy is unavailable", () => {
  assert.throws(() => newRequestId(null), { code: "SECURE_RANDOM_UNAVAILABLE" });
  assert.throws(() => newRequestId({ getRandomValues() { throw new Error("browser internals"); } }), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.code, "SECURE_RANDOM_UNAVAILABLE");
    assert.doesNotMatch(error.message, /browser internals/);
    return true;
  });
});

test("authorization resumes only with the official URL and converts seconds", () => {
  assert.equal(checkedAttempt(attempt).expiresAt, 1_800_000_000_000);
  for (const url of [
    `https://mcp-center.wps.cn.evil.test/kdocs-auth/auth-guide?auth_code=${authCode}`,
    `https://mcp-center.wps.cn/kdocs-auth/auth-guide?auth_code=${authCode}&redirect=https://evil.test`,
    `http://mcp-center.wps.cn/kdocs-auth/auth-guide?auth_code=${authCode}`,
    `https://user:pass@mcp-center.wps.cn/kdocs-auth/auth-guide?auth_code=${authCode}`,
    `https://mcp-center.wps.cn/kdocs-auth/auth-guide?auth_code=${authCode}#other`,
  ]) assert.throws(() => checkedAttempt({ ...attempt, authorizationUrl: url }), { code: "INVALID_AUTH_URL" });
});

test("safe diagnostic excludes error messages, partial content and credentials", () => {
  const error = new ApiError("secret-user-token", { code: "UPSTREAM_NETWORK", status: 502, stage: "fetch", requestId: "safe-request-id", partialResult: { document: "private contents", access_token: "secret-user-token" } });
  assert.deepEqual(JSON.parse(safeDiagnostic(error)), { code: "UPSTREAM_NETWORK", requestId: "safe-request-id", stage: "fetch", httpStatus: 502 });
  assert.doesNotMatch(safeDiagnostic(error), /secret|private|document|access_token/);
  assert.deepEqual(JSON.parse(safeDiagnostic(new ApiError("ignored", { code: "bad code\nsecret", stage: "https://example.com", status: 0 }))), { code: "CLIENT_ERROR" });
});

test("retryable transport errors retain diagnostics and partial result for the result panel", async () => {
  const partial = { data: { file_id: "created-file-id" } };
  await assert.rejects(apiRequest("/api/wps/call", {}, { fetchImpl: responseFetch({ error: { code: "UPSTREAM_NETWORK", message: "暂时无法连接", retryable: true, requestId: "req-1", stage: "fetch", partialResult: partial } }, 502) }), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.retryable, true);
    assert.equal(error.requestId, "req-1");
    assert.deepEqual(error.partialResult, partial);
    assert.doesNotMatch(safeDiagnostic(error), /file_id|created-file-id/);
    return true;
  });
});

test("HTTP 200 workflow failures preserve all step outputs rather than becoming transport errors", async () => {
  const result = { status: "partial", requestId: "req-2", steps: [{ id: "created", status: "succeeded", output: { file_id: "real-id", status: "processing" } }], error: { code: "WPS_PERMISSION", message: "第二步无权访问" } };
  assert.deepEqual(await apiRequest("/api/wps/run", {}, { fetchImpl: responseFetch(result) }), result);
});

test("manual credential is redacted in display errors and not put in diagnostic", async () => {
  const secret = "manual-private-credential";
  await assert.rejects(apiRequest("/api/wps/token", { token: secret }, { secret, fetchImpl: responseFetch({ error: { code: "WPS_AUTH_EXPIRED", message: `${secret} expired ${secret}`, retryable: false } }, 401) }), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.retryable, false);
    assert.doesNotMatch(error.message, /manual-private-credential/);
    assert.equal(error.message, "[已隐藏凭据] expired [已隐藏凭据]");
    assert.doesNotMatch(safeDiagnostic(error), /manual-private-credential/);
    return true;
  });
});

test("network failure is retryable and the request is never automatically replayed", async () => {
  let calls = 0;
  await assert.rejects(apiRequest("/api/wps/run", {}, { fetchImpl: (async () => { calls++; throw new TypeError("Failed to fetch"); }) as typeof fetch }), (error: unknown) => error instanceof ApiError && error.retryable && error.code === "NETWORK_ERROR");
  assert.equal(calls, 1);
  assert.deepEqual([1, 2, 3, 4, 99].map(retryDelay), [2_500, 5_000, 10_000, 15_000, 15_000]);
});

test("malformed success cannot masquerade as a completed operation", async () => {
  await assert.rejects(apiRequest("/api/wps/run", {}, { fetchImpl: (async () => new Response("not json", { status: 200 })) as typeof fetch }), { code: "INVALID_RESPONSE", retryable: true });
});

test("generated schema examples use placeholders for real file ids", () => {
  assert.deepEqual(schemaExample({ type: "object", required: ["file_id", "worksheet_id", "mode"], properties: { file_id: { type: "string" }, worksheet_id: { type: "number" }, mode: { type: "string", enum: ["get", "update"] } } }), { file_id: "请填写刚读取的真实 ID", worksheet_id: 0, mode: "get" });
});
