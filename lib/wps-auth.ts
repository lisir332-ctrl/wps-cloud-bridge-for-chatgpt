import { keyReady, seal, unseal } from "./wps-crypto.ts";
import { WpsStore, type Connection } from "./wps-store.ts";
import { exchangeWpsCode, WpsError, WpsMcpClient, type McpToolResult } from "./wps-upstream.ts";

export const APP_VERSION = "0.7.0";
// This is the bridge's waiting window, not a claim about WPS token lifetime.
export const AUTH_TTL = 10 * 60_000;
export type RuntimeEnv = { DB?: D1Database; WPS_ENCRYPTION_KEY?: string; SITE_ORIGIN?: string };
export type ConnectionStatus = {
  connected: boolean; status: "not_connected" | "expired" | "connected";
  serviceReady: boolean; upstreamVerified: boolean; version: string;
  connectedAt?: number; expiresAt?: number | null; verifiedAt?: number;
  pending?: { attemptId: string; authorizationUrl: string; expiresAt: number };
};

export function actorFrom(request: Request): string {
  const actor = request.headers.get("oai-authenticated-user-id");
  if (!actor || actor.length > 256 || /[\s\x00-\x1f]/.test(actor))
    throw new WpsError("SIGN_IN_REQUIRED", "请先使用 ChatGPT 登录此私有连接页面。", 401);
  return actor;
}

export function requireSameOrigin(request: Request, env: RuntimeEnv) {
  const expected = env.SITE_ORIGIN || new URL(request.url).origin;
  if (request.headers.get("origin") !== new URL(expected).origin ||
      request.headers.get("sec-fetch-site") === "cross-site")
    throw new WpsError("ORIGIN_REJECTED", "请从连接页面发起此操作。", 403);
}

export function service(env: RuntimeEnv) {
  if (!env.DB || !keyReady(env.WPS_ENCRYPTION_KEY))
    throw new WpsError("SERVICE_NOT_READY", "连接服务配置尚未就绪，请稍后重试。", 503);
  return { store: new WpsStore(env.DB), key: env.WPS_ENCRYPTION_KEY };
}

function viewConnection(connection: Connection | null, now: number): ConnectionStatus {
  const expired = !!connection && (!!connection.expired || (connection.expires_at !== null && connection.expires_at <= now));
  return {
    connected: !!connection && !expired,
    status: connection ? (expired ? "expired" : "connected") : "not_connected",
    serviceReady: true, upstreamVerified: !!connection?.verified_at && !expired, version: APP_VERSION,
    ...(connection?.verified_at ? { verifiedAt: connection.verified_at } : {}),
    ...(connection ? { connectedAt: connection.connected_at, expiresAt: connection.expires_at } : {}),
  };
}

export async function connectionStatus(actor: string, env: RuntimeEnv, now = Date.now(), includePending = false): Promise<ConnectionStatus> {
  const ready = !!env.DB && keyReady(env.WPS_ENCRYPTION_KEY);
  if (!ready) return { connected: false, status: "not_connected", serviceReady: false, upstreamVerified: false, version: APP_VERSION };
  const store = new WpsStore(env.DB!);
  const connection = await store.getConnection(actor);
  // Only the same-origin account page asks for this. The MCP status tool never
  // returns an authorization code or login URL to the model.
  const attempt = includePending ? await store.getAttempt(actor) : null;
  let pending: { attemptId: string; authorizationUrl: string; expiresAt: number } | undefined;
  if (attempt && attempt.expires_at > now) {
    const code = await unseal({ cipher: attempt.code_cipher, iv: attempt.code_iv }, env.WPS_ENCRYPTION_KEY!, actor, `auth:${attempt.attempt_id}`);
    pending = { attemptId: attempt.attempt_id, authorizationUrl: authorizationUrl(code), expiresAt: attempt.expires_at };
  }
  return {
    ...viewConnection(connection, now),
    ...(pending ? { pending } : {}),
  };
}

function authorizationUrl(code: string) {
  return `https://mcp-center.wps.cn/kdocs-auth/auth-guide?auth_code=${encodeURIComponent(code)}`;
}

export async function beginConnection(actor: string, env: RuntimeEnv, now = Date.now()) {
  const { store, key } = service(env);
  const existing = await store.getAttempt(actor);
  if (existing && existing.created_at > now - 5_000)
    throw new WpsError("TOO_MANY_ATTEMPTS", "刚刚已发起连接，请稍等几秒后再试。", 429);
  const attemptId = crypto.randomUUID();
  const authCode = crypto.randomUUID();
  const expiresAt = now + AUTH_TTL;
  await store.putAttempt(actor, attemptId, await seal(authCode, key, actor, `auth:${attemptId}`), now, expiresAt);
  return {
    attemptId,
    authorizationUrl: authorizationUrl(authCode),
    expiresAt,
  };
}

export async function pollConnection(actor: string, attemptId: string, env: RuntimeEnv,
  exchange: typeof exchangeWpsCode = exchangeWpsCode, clock: () => number = Date.now) {
  if (!/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(attemptId))
    throw new WpsError("INVALID_ATTEMPT", "连接请求无效，请重新发起授权。", 400);
  const { store, key } = service(env);
  const now = clock();
  const attempt = await store.getAttempt(actor);
  if (!attempt || attempt.attempt_id !== attemptId) {
    const current = await store.getConnection(actor);
    return { status: current?.connection_id === attemptId && !current.expired &&
      (current.expires_at === null || current.expires_at > now) ? "connected" : "expired" };
  }
  if (attempt.expires_at <= now) {
    await store.removeAttempt(actor, attemptId);
    return { status: "expired", message: "本次授权已超时，请重新连接。" };
  }
  const lease = crypto.randomUUID();
  if (!await store.claimAttempt(actor, attemptId, lease, now)) return { status: "pending" };
  try {
    const code = await unseal({ cipher: attempt.code_cipher, iv: attempt.code_iv }, key, actor, `auth:${attemptId}`);
    const result = await exchange(code);
    if (result.status === "pending") return { status: "pending" };
    if (result.status === "cancelled") {
      await store.removeAttempt(actor, attemptId);
      return { status: "cancelled", message: "你已在 WPS 页面取消授权，可以随时重新连接。" };
    }
    if (!result.token) throw new WpsError("UPSTREAM_INVALID_RESPONSE", "WPS 未返回有效授权，请重新连接。", 502);
    const completedAt = clock();
    if (typeof result.expiresIn === "number" && Number.isFinite(result.expiresIn) && result.expiresIn <= 0) {
      await store.removeAttempt(actor, attemptId);
      return { status: "expired", message: "WPS 返回的授权已经过期，请重新连接。" };
    }
    const expiresAt = typeof result.expiresIn === "number" && Number.isFinite(result.expiresIn) && result.expiresIn > 0
      ? completedAt + result.expiresIn * 1000 : null;
    if (expiresAt !== null && (!Number.isFinite(expiresAt) || expiresAt > Number.MAX_SAFE_INTEGER))
      throw new WpsError("UPSTREAM_INVALID_RESPONSE", "WPS 返回的授权有效期无效，请重新连接。", 502);
    const saved = await store.completeAttempt(actor, attemptId, lease,
      await seal(result.token, key, actor, "token"), completedAt, expiresAt);
    return { status: saved ? "connected" : "expired" };
  } finally {
    await store.releaseAttempt(actor, attemptId, lease);
  }
}

export async function activeCredential(actor: string, env: RuntimeEnv) {
  const { store, key } = service(env);
  const row = await store.getConnection(actor);
  if (!row) throw new WpsError("NOT_CONNECTED", "请先打开连接页面，用你的个人 WPS 账号授权。", 409);
  if (row.expired || (row.expires_at !== null && row.expires_at <= Date.now()))
    throw new WpsError("WPS_AUTH_EXPIRED", "WPS 授权已失效，请打开连接页面重新授权。", 409);
  const token = await unseal({ cipher: row.token_cipher, iv: row.token_iv }, key, actor, "token");
  return { store, connectionId: row.connection_id, token };
}

export async function cancelConnection(actor: string, attemptId: string, env: RuntimeEnv) {
  if (!/^[a-f\d-]{36}$/i.test(attemptId)) throw new WpsError("INVALID_ATTEMPT", "连接请求无效。", 400);
  await service(env).store.removeAttempt(actor, attemptId);
  return { cancelled: true };
}

type ClientFactory = (token: string) => Pick<WpsMcpClient, "callTool">;
const clientFactory: ClientFactory = (token) => new WpsMcpClient(token);

// This marker contains no user data. Searching only names for this improbable
// constant proves the authenticated search endpoint works without reading bodies.
const VERIFICATION_SEARCH = Object.freeze({
  keyword: "__wps_connection_probe_7fd6b942_95df_4c31_a01c_6ea8f6d873b2__", type: "file_name", page_size: 1,
});
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function validationFailed(): never {
  throw new WpsError("WPS_VALIDATION_FAILED", "WPS 未返回可核实的个人文件列表，账号读取验证未通过。请确认使用个人账号的金山文档 Skill 授权。", 422);
}
function validationOutput(result: McpToolResult): Record<string, unknown> {
  if (result.isError) validationFailed();
  if (result.structuredContent !== undefined) return result.structuredContent;
  const candidates: Record<string, unknown>[] = [];
  for (const block of result.content) {
    let value: unknown;
    try { value = JSON.parse(block.text) as unknown; } catch { continue; }
    if (record(value) && Object.hasOwn(value, "code") && Object.hasOwn(value, "data")) candidates.push(value);
  }
  if (candidates.length !== 1) validationFailed();
  return candidates[0];
}
function fileInfo(value: unknown): boolean {
  return record(value) && typeof value.id === "string" && !!value.id && typeof value.name === "string" && !!value.name &&
    ["file", "folder", "shortcut"].includes(String(value.type));
}
function validateCredentialList(result: McpToolResult, tool: "list_my_files" | "search_files") {
  const output = validationOutput(result);
  if ((output.code !== 0 && output.code !== "0") || !record(output.data)) validationFailed();
  const data = output.data;
  // page_size=1 is fixed; an empty items array is a valid authenticated result.
  if (!Array.isArray(data.items) || data.items.length > 1 ||
    (Object.hasOwn(data, "next_page_token") && typeof data.next_page_token !== "string")) validationFailed();
  if (tool === "list_my_files") {
    if ((Object.hasOwn(data, "drive_id") && (typeof data.drive_id !== "string" || !data.drive_id)) ||
      (Object.hasOwn(data, "parent_id") && data.parent_id !== "0") ||
      (Object.hasOwn(data, "drive_source") && !["special", "latest_items"].includes(String(data.drive_source))) ||
      !data.items.every(fileInfo)) validationFailed();
  } else {
    if (!data.items.every((item) => record(item) && fileInfo(item.file))) validationFailed();
    if (data.total !== undefined && (typeof data.total !== "number" || !Number.isSafeInteger(data.total) || data.total < 0)) validationFailed();
  }
}
function suggestedSearchFallback(error: unknown): boolean {
  if (!(error instanceof WpsError) || error.code !== "UPSTREAM_ERROR" || error.diagnostic.businessCode !== 400001 ||
    [401, 403, 429].includes(error.status) || [401, 403, 429].includes(error.diagnostic.httpStatus ?? 0)) return false;
  const partial = error.partialResult;
  if (!record(partial) || (partial.code !== 400001 && partial.code !== "400001") || !record(partial.data)) return false;
  const actions = partial.data.next_actions;
  // Only recognize the exact tool name. Never copy arguments, URLs, or prose
  // supplied by next_actions, and never execute another recommended tool.
  return Array.isArray(actions) && actions.length <= 20 && actions.some((action) =>
    action === "search_files" || (record(action) && action.tool === "search_files"));
}

async function checkCredential(token: string, createClient: ClientFactory) {
  // tools/list is available anonymously, so it cannot verify this user's access.
  // A single root-directory item is the normal bounded business check.
  const client = createClient(token);
  let result: McpToolResult;
  try { result = await client.callTool("list_my_files", { page_size: 1 }); }
  catch (error) {
    // The official default-drive resolution error is the sole fallback. Auth,
    // permission, rate-limit, timeout and unknown-response failures do not retry.
    if (!suggestedSearchFallback(error)) throw error;
    validateCredentialList(await client.callTool("search_files", { ...VERIFICATION_SEARCH }), "search_files");
    return;
  }
  validateCredentialList(result, "list_my_files");
}

export async function verifyConnection(actor: string, env: RuntimeEnv, createClient: ClientFactory = clientFactory) {
  const { store, connectionId, token } = await activeCredential(actor, env);
  try {
    await checkCredential(token, createClient);
    const checkedAt = Date.now();
    await store.markVerified(actor, connectionId, checkedAt).catch(() => undefined);
    const current = await store.getConnection(actor);
    if (!current || current.connection_id !== connectionId)
      throw new WpsError("CONNECTION_CHANGED", "验证期间连接已断开或更改，请刷新后验证当前账号。", 409);
    return { ...viewConnection(current, Date.now()), checkedAt };
  } catch (error) {
    if (error instanceof WpsError && error.code === "WPS_AUTH_EXPIRED") await store.markExpired(actor, connectionId);
    throw error;
  }
}

/** Protected page only; this is deliberately not an MCP tool. */
export async function importPersonalToken(actor: string, tokenValue: unknown, env: RuntimeEnv,
  createClient: ClientFactory = clientFactory) {
  if (typeof tokenValue !== "string" || !tokenValue.trim() || tokenValue.length > 16_384 || /[\r\n]/.test(tokenValue))
    throw new WpsError("INVALID_TOKEN", "请输入金山文档官方个人 Skill 页面生成的完整授权密钥。", 400);
  const token = tokenValue.trim();
  const { store, key } = service(env);
  const attempt = await beginConnection(actor, env);
  const lease = crypto.randomUUID();
  if (!await store.claimAttempt(actor, attempt.attemptId, lease, Date.now(), 90_000))
    throw new WpsError("CONNECTION_CHANGED", "连接状态已变化，请刷新后重试。", 409);
  try {
    await checkCredential(token, createClient);
    const now = Date.now();
    const saved = await store.completeAttempt(actor, attempt.attemptId, lease,
      await seal(token, key, actor, "token"), now, null);
    if (!saved) throw new WpsError("CONNECTION_CHANGED", "验证期间连接已取消或更新，请刷新后重试。", 409);
    await store.markVerified(actor, attempt.attemptId, now).catch(() => undefined);
    const current = await store.getConnection(actor);
    if (!current || current.connection_id !== attempt.attemptId)
      throw new WpsError("CONNECTION_CHANGED", "保存后连接又被断开或更改，请刷新检查当前账号。", 409);
    return viewConnection(current, Date.now());
  } finally {
    await store.removeAttempt(actor, attempt.attemptId);
    await store.releaseAttempt(actor, attempt.attemptId, lease);
  }
}
