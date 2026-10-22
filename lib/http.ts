import { WpsError } from "./wps-upstream.ts";

export function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store",
      "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" },
  });
}

export async function readJson(request: Request, limit = 524_288): Promise<unknown> {
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json"))
    throw new WpsError("INVALID_REQUEST", "请求必须为 JSON。", 415);
  if (Number(request.headers.get("content-length")) > limit)
    throw new WpsError("REQUEST_TOO_LARGE", "单次请求内容过大，请拆分处理。", 413);
  const reader = request.body?.getReader();
  if (!reader) throw new WpsError("INVALID_REQUEST", "缺少请求内容。", 400);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new WpsError("REQUEST_TOO_LARGE", "单次请求内容过大，请拆分处理。", 413);
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const all = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder().decode(all)); }
  catch { throw new WpsError("INVALID_REQUEST", "JSON 请求格式不正确。", 400); }
}

export function safeError(error: unknown) {
  return error instanceof WpsError ? error : new WpsError("INTERNAL_ERROR", "连接服务暂时无法完成操作，请稍后重试。", 500);
}

/** Whitelisted scalars only: never pass upstream messages, requests or headers. */
export function errorResponse(cause: unknown, route: string) {
  const error = safeError(cause);
  const requestId = crypto.randomUUID();
  const diagnostic = error.diagnostic;
  console.error(JSON.stringify({ event: "wps_bridge_error", requestId,
    route: /^[a-z-]{1,40}$/.test(route) ? route : "unknown", code: error.code,
    status: error.status, retryable: error.retryable, ...diagnostic }));
  return json({ error: { code: error.code, message: error.message,
    retryable: error.retryable, requestId, ...diagnostic,
    ...(error.partialResult ? { partialResult: error.partialResult } : {}) } }, error.status);
}
