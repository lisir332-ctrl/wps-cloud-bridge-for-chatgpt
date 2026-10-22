/**
 * A bounded, per-connection client for WPS's personal-account cloud MCP.
 * Protocol reference: zhengjy01/dsh-wps @ c59a2f869c336364c8d109194a8a83fc6b55d56c
 * (MIT), src/auth.ts and src/mcp.ts. This implementation does not persist tokens.
 */

const MCP_URL = "https://mcp-center.wps.cn/skill_hub/mcp";
const EXCHANGE_URL = "https://api.wps.cn/office/v5/ai/skill_hub/wps_auth/exchange";
const CLIENT = "wps-cloud-bridge/0.8.1";
const REQUEST_TIMEOUT_MS = 25_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_TOOL_PAGES = 100;
const MAX_TOOLS = 10_000;
const REDACTED = "[已隐藏凭据]";

export type SafeDiagnostic = {
  stage?: "fetch" | "http" | "json" | "shape";
  httpStatus?: number;
  businessCode?: number;
  contentType?: "json" | "sse" | "html" | "other";
  errorName?: "TypeError" | "Error" | "AbortError";
  elapsedMs?: number;
};

export class WpsError extends Error {
  code: string;
  status: number;
  diagnostic: SafeDiagnostic;
  partialResult?: Record<string, unknown>;

  constructor(code: string, message: string, status = 400, diagnostic: SafeDiagnostic = {}) {
    super(message);
    this.name = "WpsError";
    this.code = code;
    this.status = status;
    this.diagnostic = diagnostic;
  }

  get retryable() { return this.status === 429 || (this.status >= 500 && this.code !== "UPSTREAM_REDIRECT_REJECTED"); }
}

export type McpToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
};

type JsonRecord = Record<string, unknown>;
type Tool = { name: string; inputSchema: JsonRecord };
type RpcId = number;

function record(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function own(value: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function numericCode(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?\d{1,12}$/.test(value)) return Number(value);
  return undefined;
}

function invalidResponse(stage: SafeDiagnostic["stage"] = "shape"): WpsError {
  return new WpsError("UPSTREAM_INVALID_RESPONSE", "WPS 返回的数据格式不完整或无法识别，请稍后重试。", 502, { stage });
}

function timeoutError(): WpsError {
  return new WpsError("UPSTREAM_TIMEOUT", "WPS 响应超时。若刚刚提交了修改，请先检查文档是否已更新，再决定是否重试。", 504);
}

function tooLarge(): WpsError {
  return new WpsError("UPSTREAM_TOO_LARGE", "WPS 响应超过 4 MB，未完整读取。请缩小读取范围后重试。", 502);
}

function upstreamError(code?: number, authorization = false): WpsError {
  if (authorization && code === 403001) {
    return new WpsError("WPS_PERSONAL_ACCOUNT_REQUIRED", "此连接目前仅支持个人 WPS 账号，请在 WPS 授权页面切换到个人账号后重新连接。", 403);
  }
  if (code === 401 || code === 400006) {
    return new WpsError("WPS_AUTH_EXPIRED", "WPS 授权已失效，请打开连接页面重新授权。", 401);
  }
  if (code === 403 || code === 403001) {
    return new WpsError("WPS_FORBIDDEN", "WPS 拒绝了此次操作，请检查当前账号是否拥有该文档的相应权限。", 403);
  }
  if (code === 429 || code === 429001 || code === 429002) {
    return new WpsError("WPS_RATE_LIMITED", "WPS 当前请求较多，请稍等一会再试。", 429);
  }
  return new WpsError("UPSTREAM_ERROR", "WPS 暂时未能完成此次操作。若提交了修改，请先检查文档状态，再决定是否重试。", 502);
}

/** Only recognize a business envelope at this exact root; never scan document data. */
function businessCode(value: unknown): number | undefined {
  if (!record(value) || !own(value, "code")) return undefined;
  const envelope = own(value, "data") || own(value, "result") ||
    (own(value, "msg") && typeof value.msg === "string") ||
    (own(value, "message") && typeof value.message === "string");
  return envelope ? numericCode(value.code) : undefined;
}

function checkBusinessResult(value: unknown, token = ""): void {
  const code = businessCode(value);
  if (code !== undefined && code !== 0) {
    const error = upstreamError(code);
    error.diagnostic.businessCode = code;
    // WPS may create a file before a later formatting step fails. Preserve its
    // returned ID and diagnostics so callers can inspect it instead of creating
    // a duplicate. This data is never written to application logs or the ledger.
    if (record(value)) error.partialResult = sanitize(value, token) as JsonRecord;
    throw error;
  }
}

const SENSITIVE_KEYS = new Set([
  "token", "accesstoken", "refreshtoken", "idtoken", "authorization", "proxyauthorization",
  "clientsecret", "password", "secret", "apikey", "bearertoken", "wpstoken", "sessiontoken",
]);

function sensitiveKey(key: string): boolean {
  // page_token / next_page_token are document pagination cursors and stay usable.
  return SENSITIVE_KEYS.has(key.toLowerCase().replace(/[-_\s]/g, ""));
}

function redactText(text: string, token: string): string {
  return token ? text.split(token).join(REDACTED) : text;
}

/** Redaction is recursive; business-error detection deliberately is not. */
function sanitize(value: unknown, token: string, depth = 0): unknown {
  if (depth > 64) {
    throw new WpsError("UPSTREAM_TOO_COMPLEX", "WPS 响应层级过深，未完整处理。请缩小读取范围后重试。", 502);
  }
  if (typeof value === "string") {
    const safe = redactText(value, token);
    const trimmed = safe.trim();
    // WPS often places its business JSON in a text content block. Also protect
    // JSON strings nested inside that document without interpreting their codes.
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      let parsed: unknown;
      try { parsed = JSON.parse(safe); } catch { return safe; }
      const clean = sanitize(parsed, token, depth + 1);
      return JSON.stringify(clean) === JSON.stringify(parsed) ? safe : JSON.stringify(clean);
    }
    return safe;
  }
  if (Array.isArray(value)) return value.map((item) => sanitize(item, token, depth + 1));
  if (record(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      redactText(key, token), sensitiveKey(key) ? REDACTED : sanitize(item, token, depth + 1),
    ]));
  }
  return value;
}

function cancelBody(body: ReadableStream<Uint8Array> | null): void {
  if (body) void body.cancel().catch(() => undefined);
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  // Do not await: a long-lived SSE producer may never resolve its cancellation.
  try { void reader.cancel().catch(() => undefined); } catch { /* Already released. */ }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(timeoutError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(timeoutError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function checkLength(response: Response): void {
  const length = response.headers.get("content-length");
  if (length !== null && /^\d+$/.test(length) && Number(length) > MAX_RESPONSE_BYTES) {
    cancelBody(response.body);
    throw tooLarge();
  }
}

async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
  checkLength(response);
  const reader = response.body?.getReader();
  if (!reader) throw invalidResponse();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  try {
    while (true) {
      const { value, done } = await abortable(reader.read(), signal);
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) throw tooLarge();
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    try { return JSON.parse(text); } catch { throw invalidResponse("json"); }
  } finally {
    cancelReader(reader);
    try { reader.releaseLock(); } catch { /* A cancelled read may still be settling. */ }
  }
}

async function readSse(response: Response, signal: AbortSignal, expectedId: RpcId): Promise<unknown> {
  checkLength(response);
  const reader = response.body?.getReader();
  if (!reader) throw invalidResponse();
  const decoder = new TextDecoder();
  let total = 0;
  let buffer = "";
  let data: string[] = [];

  const dispatch = (): unknown | undefined => {
    if (!data.length) return undefined;
    const event = data.join("\n");
    data = [];
    let value: unknown;
    try { value = JSON.parse(event); } catch { throw invalidResponse(); }
    if (record(value) && value.id === expectedId) return value;
    return undefined; // Notifications and other request ids belong to other events.
  };

  const line = (value: string): unknown | undefined => {
    if (value === "") return dispatch();
    if (value.startsWith(":")) return undefined;
    const separator = value.indexOf(":");
    const field = separator === -1 ? value : value.slice(0, separator);
    let contents = separator === -1 ? "" : value.slice(separator + 1);
    if (contents.startsWith(" ")) contents = contents.slice(1);
    if (field === "data") data.push(contents);
    return undefined;
  };

  const consume = (end: boolean): unknown | undefined => {
    while (true) {
      const index = buffer.search(/[\r\n]/);
      if (index === -1 || (!end && buffer[index] === "\r" && index === buffer.length - 1)) break;
      const value = buffer.slice(0, index);
      const separatorLength = buffer[index] === "\r" && buffer[index + 1] === "\n" ? 2 : 1;
      buffer = buffer.slice(index + separatorLength);
      const message = line(value);
      if (message !== undefined) return message;
    }
    if (end) {
      if (buffer) {
        const message = line(buffer);
        buffer = "";
        if (message !== undefined) return message;
      }
      return dispatch();
    }
    return undefined;
  };

  try {
    while (true) {
      const { value, done } = await abortable(reader.read(), signal);
      if (done) {
        buffer += decoder.decode();
        const message = consume(true);
        if (message !== undefined) return message;
        throw invalidResponse();
      }
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) throw tooLarge();
      buffer += decoder.decode(value, { stream: true });
      const message = consume(false);
      if (message !== undefined) return message;
    }
  } finally {
    cancelReader(reader);
    try { reader.releaseLock(); } catch { /* A cancelled read may still be settling. */ }
  }
}

async function performRequest<T>(
  fetchImpl: typeof fetch,
  url: string,
  headers: Headers,
  payload: JsonRecord,
  handle: (response: Response, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  let body: string;
  try { body = JSON.stringify(payload); }
  catch { throw new WpsError("INVALID_ARGUMENTS", "请求参数无法转换为 JSON，请检查输入。", 400); }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const startedAt = Date.now();
  let diagnostic: SafeDiagnostic = { stage: "fetch" };
  try {
    const response = await abortable(fetchImpl(url, {
      method: "POST", headers, body, signal: controller.signal,
      // A redirect must never forward this connection's bearer credential elsewhere.
      // workerd supports only "follow" and "manual". "error" throws before
      // sending anything, even though Node's fetch accepts it.
      redirect: "manual", credentials: "omit", cache: "no-store",
    }), controller.signal);
    const contentType = response.headers.get("content-type")?.toLowerCase() || "";
    diagnostic = { stage: "http", httpStatus: response.status,
      contentType: contentType.includes("json") ? "json" : contentType.includes("event-stream") ? "sse" : contentType.includes("html") ? "html" : "other" };
    if (response.status >= 300 && response.status < 400) {
      cancelBody(response.body);
      throw new WpsError("UPSTREAM_REDIRECT_REJECTED", "WPS 接口返回了重定向，连接服务已停止请求。请保留诊断编号以便排查。", 502);
    }
    return await handle(response, controller.signal);
  } catch (error) {
    const safe = error instanceof WpsError ? error : controller.signal.aborted ? timeoutError() : upstreamError();
    const errorName = error instanceof TypeError ? "TypeError" : error instanceof Error && error.name === "AbortError" ? "AbortError" : "Error";
    safe.diagnostic = { ...diagnostic, ...safe.diagnostic, elapsedMs: Date.now() - startedAt, errorName };
    // Network errors can contain request headers or URLs. Never surface them.
    throw safe;
  } finally {
    clearTimeout(timer);
  }
}

function baseHeaders(): Headers {
  return new Headers({
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
    "User-Agent": CLIENT,
    "X-Request-Source": CLIENT,
    "X-Skill-Version": "1.0.0",
  });
}

async function checkHttp(response: Response, signal: AbortSignal, authorization = false): Promise<void> {
  if (response.ok) return;
  if ([401, 403, 429].includes(response.status) || response.status >= 500) {
    cancelBody(response.body);
    throw upstreamError(response.status, authorization);
  }
  // Some deployments report expired tokens in a JSON business envelope with 400.
  let value: unknown;
  try { value = await readJson(response, signal); }
  catch (error) {
    if (error instanceof WpsError && ["UPSTREAM_TIMEOUT", "UPSTREAM_TOO_LARGE"].includes(error.code)) throw error;
    throw upstreamError(response.status, authorization);
  }
  const code = businessCode(value);
  throw upstreamError(code === undefined || code === 0 ? response.status : code, authorization);
}

export class WpsMcpClient {
  private token: string;
  private fetchImpl: typeof fetch;
  private sessionId: string | undefined;
  private protocolVersion = "2024-11-05";
  private initialized = false;
  private initialization: Promise<void> | undefined;
  private nextId = 1;

  constructor(token: string, fetchImpl: typeof fetch = fetch) {
    if (typeof token !== "string" || !token.trim() || token.length > 16_384 || /[\r\n]/.test(token)) {
      throw new WpsError("WPS_AUTH_EXPIRED", "缺少有效的 WPS 授权，请先打开连接页面完成授权。", 401);
    }
    this.token = token;
    this.fetchImpl = fetchImpl;
  }

  private async rpc(method: string, params?: JsonRecord, notification = false): Promise<unknown> {
    const id = notification ? undefined : this.nextId++;
    const payload: JsonRecord = { jsonrpc: "2.0", method };
    if (params !== undefined) payload.params = params;
    if (id !== undefined) payload.id = id;
    const headers = baseHeaders();
    headers.set("Authorization", `Bearer ${this.token}`);
    if (this.sessionId) headers.set("Mcp-Session-Id", this.sessionId);
    if (this.initialized || method === "notifications/initialized") {
      headers.set("MCP-Protocol-Version", this.protocolVersion);
    }

    return performRequest(this.fetchImpl, MCP_URL, headers, payload, async (response, signal) => {
      await checkHttp(response, signal);
      const sessionId = response.headers.get("mcp-session-id");
      if (sessionId) {
        if (sessionId.length > 1_024 || /[\r\n]/.test(sessionId)) {
          cancelBody(response.body);
          throw invalidResponse();
        }
        this.sessionId = sessionId;
      }
      if (id === undefined) {
        cancelBody(response.body);
        return undefined;
      }
      const message = response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")
        ? await readSse(response, signal, id) : await readJson(response, signal);
      if (!record(message) || message.jsonrpc !== "2.0" || message.id !== id) {
        checkBusinessResult(message, this.token);
        throw invalidResponse();
      }
      if (own(message, "error")) {
        const errorCode = record(message.error) ? numericCode(message.error.code) : undefined;
        throw upstreamError(errorCode);
      }
      if (!own(message, "result")) throw invalidResponse();
      checkBusinessResult(message.result, this.token);
      return message.result;
    });
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    if (!this.initialization) {
      this.initialization = (async () => {
        const result = await this.rpc("initialize", {
          protocolVersion: "2024-11-05", capabilities: {},
          clientInfo: { name: "wps-cloud-bridge", version: "0.8.1" },
        });
        if (!record(result) || typeof result.protocolVersion !== "string" ||
            !/^\d{4}-\d{2}-\d{2}$/.test(result.protocolVersion)) throw invalidResponse();
        this.protocolVersion = result.protocolVersion;
        await this.rpc("notifications/initialized", undefined, true);
        this.initialized = true;
      })();
    }
    try { await this.initialization; }
    finally { this.initialization = undefined; }
  }

  async listTools(): Promise<Tool[]> {
    await this.ensureInitialized();
    const tools: Tool[] = [];
    const cursors = new Set<string>();
    const names = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_TOOL_PAGES; page++) {
      const result = await this.rpc("tools/list", cursor ? { cursor } : {});
      if (!record(result) || !Array.isArray(result.tools)) throw invalidResponse();
      for (const tool of result.tools) {
        if (!record(tool) || typeof tool.name !== "string" || !tool.name || !record(tool.inputSchema)) throw invalidResponse();
        if (names.has(tool.name)) throw invalidResponse();
        names.add(tool.name);
        tools.push({ name: redactText(tool.name, this.token), inputSchema: sanitize(tool.inputSchema, this.token) as JsonRecord });
        if (tools.length > MAX_TOOLS) throw new WpsError("UPSTREAM_TOO_LARGE", "WPS 工具列表过长，未完整加载。请稍后重试。", 502);
      }
      if (result.nextCursor === undefined || result.nextCursor === null || result.nextCursor === "") return tools;
      if (typeof result.nextCursor !== "string" || cursors.has(result.nextCursor)) throw invalidResponse();
      cursor = result.nextCursor;
      cursors.add(cursor);
    }
    throw new WpsError("UPSTREAM_TOO_LARGE", "WPS 工具列表分页过多，未完整加载。请稍后重试。", 502);
  }

  async callTool(name: string, args: JsonRecord): Promise<McpToolResult> {
    if (typeof name !== "string" || !name || name.length > 512 || !record(args)) {
      throw new WpsError("INVALID_ARGUMENTS", "工具名称或参数不正确。", 400);
    }
    await this.ensureInitialized();
    const result = await this.rpc("tools/call", { name, arguments: args });
    if (!record(result) || !Array.isArray(result.content)) throw invalidResponse();
    if (result.isError !== undefined && typeof result.isError !== "boolean") throw invalidResponse();
    if (result.structuredContent !== undefined && !record(result.structuredContent)) throw invalidResponse();
    checkBusinessResult(result.structuredContent, this.token);
    const content = result.content.map((block) => {
      if (!record(block) || typeof block.type !== "string") throw invalidResponse();
      if (block.type === "text") {
        if (typeof block.text !== "string") throw invalidResponse();
        let parsed: unknown;
        try { parsed = JSON.parse(block.text); } catch { /* Ordinary document text. */ }
        checkBusinessResult(parsed, this.token);
        return { type: "text" as const, text: sanitize(block.text, this.token) as string };
      }
      // The public bridge returns text blocks. Preserve an unexpected MCP block's
      // entire data in an explicitly labelled JSON text block instead of dropping it.
      return { type: "text" as const, text: `WPS 返回的 ${redactText(block.type, this.token)} 内容（JSON）：${JSON.stringify(sanitize(block, this.token))}` };
    });
    return {
      content,
      ...(result.isError === undefined ? {} : { isError: result.isError }),
      ...(result.structuredContent === undefined ? {} : { structuredContent: sanitize(result.structuredContent, this.token) as JsonRecord }),
    };
  }
}

export async function exchangeWpsCode(
  authCode: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ status: "pending" | "connected" | "cancelled"; token?: string; expiresIn?: number }> {
  if (typeof authCode !== "string" || !/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(authCode)) {
    throw new WpsError("INVALID_AUTH_CODE", "授权请求无效，请重新发起连接。", 400);
  }
  return performRequest(fetchImpl, EXCHANGE_URL, baseHeaders(), { code: authCode }, async (response, signal) => {
    if (response.status === 409) {
      cancelBody(response.body);
      return { status: "cancelled" };
    }
    await checkHttp(response, signal, true);
    const value = await readJson(response, signal);
    if (!record(value)) throw invalidResponse();
    const data = record(value.data) ? value.data : value;
    const code = numericCode(data.code) ?? numericCode(value.code);
    if (code === 403 || code === 403001 || code === 401 || code === 400006 ||
        code === 429 || code === 429001 || code === 429002 || (code !== undefined && code >= 500 && code < 600)) {
      throw upstreamError(code, true);
    }
    if (code === 409) return { status: "cancelled" };
    if (code === 200) {
      const token = data.token ?? value.token;
      if (typeof token !== "string" || !token.trim() || token.length > 16_384 || /[\r\n]/.test(token)) throw invalidResponse();
      const expiresIn = data.expires_in ?? value.expires_in;
      return {
        status: "connected", token,
        ...(typeof expiresIn === "number" && Number.isFinite(expiresIn) ? { expiresIn } : {}),
      };
    }
    if (code === 202) return { status: "pending" };
    if (code === undefined) throw invalidResponse();
    // Only the documented waiting code means pending. An unknown numeric error
    // must not keep a user waiting forever or be interpreted as successful login.
    const error = new WpsError("WPS_AUTH_REJECTED", "WPS 未完成此授权请求，请重新发起连接，或使用官方个人 Skill 授权备用入口。", 422,
      { stage: "shape", businessCode: code });
    throw error;
  });
}
