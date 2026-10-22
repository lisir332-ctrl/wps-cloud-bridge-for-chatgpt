export type AuthAttempt = { attemptId: string; authorizationUrl: string; expiresAt: number };
export type ConnectionStatus = {
  connected: boolean;
  status: "not_connected" | "connected" | "expired";
  connectedAt?: number;
  expiresAt?: number | null;
  verifiedAt?: number | null;
  serviceReady: boolean;
  upstreamVerified: boolean;
  version?: string;
  pending?: AuthAttempt;
};

export class ApiError extends Error {
  code: string;
  requestId?: string;
  stage?: string;
  retryable: boolean;
  status: number;
  partialResult?: unknown;

  constructor(message: string, options: { code?: string; requestId?: string; stage?: string; retryable?: boolean; status?: number; partialResult?: unknown } = {}) {
    super(message);
    this.name = "ApiError";
    this.code = options.code || "CLIENT_ERROR";
    this.requestId = options.requestId;
    this.stage = options.stage;
    this.retryable = options.retryable ?? false;
    this.status = options.status ?? 0;
    this.partialResult = options.partialResult;
  }
}

/** getRandomValues also works in HTTP previews where randomUUID is unavailable. */
export function newRequestId(randomSource: Pick<Crypto, "getRandomValues"> | null | undefined = globalThis.crypto): string {
  const bytes = new Uint8Array(16);
  try {
    if (!randomSource || typeof randomSource.getRandomValues !== "function") throw new Error("unavailable");
    randomSource.getRandomValues(bytes);
  } catch {
    throw new ApiError("浏览器暂时无法生成安全的请求编号，请刷新页面或更换浏览器后重试。", { code: "SECURE_RANDOM_UNAVAILABLE" });
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeIdentifier(value: unknown, max = 100): string | undefined {
  return typeof value === "string" && value.length <= max && /^[a-z\d_.:-]+$/i.test(value) ? value : undefined;
}

export function asApiError(value: unknown): ApiError {
  return value instanceof ApiError ? value : new ApiError(value instanceof Error ? value.message : "暂时无法完成请求，请稍后重试。");
}

/** Status reads are idempotent; a missing ChatGPT identity can appear briefly while an embedded app restores its session. */
export function statusRequestRetryable(value: unknown): boolean {
  const error = asApiError(value);
  return error.code === "SIGN_IN_REQUIRED" || error.retryable;
}

/** A deliberately small diagnostic payload: no message, URL, input, or token. */
export function safeDiagnostic(value: unknown): string {
  const error = asApiError(value);
  return JSON.stringify({
    code: safeIdentifier(error.code) || "CLIENT_ERROR",
    ...(safeIdentifier(error.requestId) ? { requestId: error.requestId } : {}),
    ...(safeIdentifier(error.stage) ? { stage: error.stage } : {}),
    ...(Number.isInteger(error.status) && error.status >= 100 && error.status <= 599 ? { httpStatus: error.status } : {}),
  }, null, 2);
}

export function retryDelay(failures: number): number {
  return Math.min(15_000, 2_500 * 2 ** Math.max(0, Math.min(failures - 1, 4)));
}

export function asMilliseconds(value: number): number {
  return value < 1_000_000_000_000 ? value * 1000 : value;
}

export function formatDate(value?: number | null): string {
  if (!value) return "—";
  const date = new Date(asMilliseconds(value));
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("zh-CN", {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

export function checkedAttempt(value: AuthAttempt): AuthAttempt {
  if (!value || typeof value.attemptId !== "string" || !/^[a-f\d-]{36}$/i.test(value.attemptId) ||
      typeof value.expiresAt !== "number" || !Number.isFinite(value.expiresAt)) {
    throw new ApiError("授权请求格式不正确，请重新连接。", { code: "INVALID_AUTH_ATTEMPT" });
  }
  let url: URL;
  try { url = new URL(value.authorizationUrl); } catch {
    throw new ApiError("授权地址未通过检查，请重新连接。", { code: "INVALID_AUTH_URL" });
  }
  if (url.protocol !== "https:" || url.hostname !== "mcp-center.wps.cn" ||
      (url.port !== "" && url.port !== "443") || url.pathname !== "/kdocs-auth/auth-guide" ||
      url.username || url.password || url.hash ||
      !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(url.searchParams.get("auth_code") || "") ||
      [...url.searchParams.keys()].some((key) => key !== "auth_code")) {
    throw new ApiError("授权地址未通过检查，请重新连接。", { code: "INVALID_AUTH_URL" });
  }
  return { ...value, authorizationUrl: url.href, expiresAt: asMilliseconds(value.expiresAt) };
}

export async function apiRequest<T>(
  path: string,
  body?: object,
  options: { signal?: AbortSignal; timeoutMs?: number; secret?: string; fetchImpl?: typeof fetch } = {},
): Promise<T> {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort();
  options.signal?.addEventListener("abort", forwardAbort, { once: true });
  if (options.signal?.aborted) controller.abort();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 35_000);
  try {
    const response = await (options.fetchImpl || fetch)(path, {
      method: body === undefined ? "GET" : "POST", credentials: "same-origin", cache: "no-store",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal,
    });
    const payload: unknown = await response.json().catch(() => null);
    const details = isRecord(payload) && isRecord(payload.error) ? payload.error : null;
    // A successful HTTP response may contain a workflow's error alongside partial
    // outputs. Keep that business result intact; transport errors use non-2xx.
    if (!response.ok) {
      const rawMessage = details?.code === "SIGN_IN_REQUIRED" ? "ChatGPT 账号上下文尚未恢复；这不代表 WPS 连接已断开。页面会再次检查，请稍候或返回此页。" :
        details && typeof details.message === "string" ? details.message.slice(0, 1000) :
        response.status === 401 ? "登录已失效，请刷新页面后重新登录。" : "服务暂时没有响应，请稍后重试。";
      const message = options.secret ? rawMessage.split(options.secret).join("[已隐藏凭据]") : rawMessage;
      throw new ApiError(message, {
        code: safeIdentifier(details?.code) || `HTTP_${response.status}`,
        requestId: safeIdentifier(details?.requestId), stage: safeIdentifier(details?.stage),
        retryable: typeof details?.retryable === "boolean" ? details.retryable : response.status === 429 || response.status >= 500,
        status: response.status,
        partialResult: details?.partialResult,
      });
    }
    if (!isRecord(payload)) throw new ApiError("未收到有效的服务响应，请稍后重试。", { code: "INVALID_RESPONSE", retryable: true });
    return payload as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof TypeError || (error instanceof Error && error.name === "AbortError")) {
      throw new ApiError("网络暂时中断，正在等待服务恢复。", { code: "NETWORK_ERROR", retryable: true, stage: "browser_request" });
    }
    throw new ApiError("请求暂时未能完成，请稍后重试。", { code: "CLIENT_ERROR" });
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", forwardAbort);
  }
}

export const OPERATION_LABELS = { read: "读取", write: "写入", sensitive: "敏感操作" } as const;
export type Operation = keyof typeof OPERATION_LABELS;

export function pretty(value: unknown): string { return JSON.stringify(value, null, 2) ?? "null"; }

/** Examples contain placeholders, never guessed file ids; the server validates again. */
export function schemaExample(schema: unknown, name = "", depth = 0): unknown {
  if (!isRecord(schema) || depth > 8) return {};
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  if (schema.default !== undefined) return schema.default;
  if (schema.type === "object" || isRecord(schema.properties)) {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required.filter((key): key is string => typeof key === "string") : [];
    const keys = required.length ? required : Object.keys(properties).filter((key) => ["file_id", "worksheet_id", "name", "title", "content"].includes(key));
    return Object.fromEntries(keys.map((key) => [key, schemaExample(properties[key], key, depth + 1)]));
  }
  if (schema.type === "array") return [schemaExample(schema.items, name, depth + 1)];
  if (schema.type === "boolean") return false;
  if (schema.type === "number" || schema.type === "integer") {
    if (/worksheet_id|sheet_id/.test(name)) return 0;
    return typeof schema.minimum === "number" ? schema.minimum : 0;
  }
  if (/file_id|parent_id|drive_id|link_id|sheet_id/.test(name)) return "请填写刚读取的真实 ID";
  if (name === "url") return "请填写用户提供的 WPS 文档链接";
  return "请填写";
}
