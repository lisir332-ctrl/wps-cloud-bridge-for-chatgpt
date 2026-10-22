import { env } from "cloudflare:workers";
import { actorFrom, APP_VERSION, beginConnection, cancelConnection, connectionStatus, importPersonalToken,
  pollConnection, requireSameOrigin, service, verifyConnection } from "../../../../lib/wps-auth.ts";
import { errorResponse, json, readJson, safeError } from "../../../../lib/http.ts";
import { exchangeWpsCode, WpsError } from "../../../../lib/wps-upstream.ts";
import { catalogSummary, getCatalogTool, listCatalog } from "../../../../lib/wps-catalog.ts";
import { executeCatalogCall, previewSensitiveCall, previewWorkflow, runWorkflow } from "../../../../lib/wps-gateway.ts";
import { listAcceptanceReports, runAcceptance } from "../../../../lib/wps-acceptance.ts";
import { generatePresentationFile } from "../../../../lib/wps-presentation-file.ts";
import { createPresentation, presentationInput, verifyPresentation } from "../../../../lib/wps-presentation-task.ts";

export const dynamic = "force-dynamic";

// Health probes use fresh, unapproved nonces, not users' credentials or data.
let healthCache: { version: string; cloudReachable: boolean; authorizationProbe: string; checkedAt: number } | undefined;
let healthPending: Promise<NonNullable<typeof healthCache>> | undefined;
let healthFailure: { error: WpsError; until: number } | undefined;
let engineCache: { version: string; presentationEngine: boolean; slideCount: number; bytes: number; checkedAt: number } | undefined;
let enginePending: Promise<NonNullable<typeof engineCache>> | undefined;

// Fixed synthetic input proves the actual deployed runtime can produce PPTX.
// It accepts no user content, reads no account and never uploads a WPS file.
async function engineProbe() {
  if (engineCache && engineCache.checkedAt > Date.now() - 300_000) return engineCache;
  if (!enginePending) enginePending = (async () => {
    try {
      const file = await generatePresentationFile({ title: "生成引擎检查", slides: [
        { title: "运行时检查", bullets: ["固定测试文字"] },
        { title: "多页结构检查", bullets: ["固定的第二页用于验证多页打包路径"] },
      ] });
      engineCache = { version: APP_VERSION, presentationEngine: true, slideCount: file.slideCount,
        bytes: atob(file.contentBase64).length, checkedAt: Date.now() };
      return engineCache;
    } finally { enginePending = undefined; }
  })();
  return enginePending;
}

async function healthProbe() {
  if (healthCache && healthCache.checkedAt > Date.now() - 60_000) return healthCache;
  if (healthFailure && healthFailure.until > Date.now()) throw healthFailure.error;
  if (!healthPending) healthPending = (async () => {
    try {
      const result = await exchangeWpsCode(crypto.randomUUID());
      if (result.status !== "pending") throw new WpsError("UPSTREAM_INVALID_RESPONSE", "授权协议探测未返回预期的等待状态。", 502);
      healthCache = { version: APP_VERSION, cloudReachable: true, authorizationProbe: "pending", checkedAt: Date.now() };
      healthFailure = undefined;
      return healthCache;
    } catch (cause) {
      healthFailure = { error: safeError(cause), until: Date.now() + 15_000 };
      throw healthFailure.error;
    } finally { healthPending = undefined; }
  })();
  return healthPending;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const action = url.pathname.split("/").pop() || "unknown";
  try {
    if (action === "health") {
      return json(await healthProbe());
    }
    if (action === "engine-health") return json(await engineProbe());
    const actor = actorFrom(request);
    if (action === "status") return json(await connectionStatus(actor, env, Date.now(), true));
    if (action === "acceptance") return json(await listAcceptanceReports(actor, env));
    if (action === "catalog") return json({ ...listCatalog({
      query: url.searchParams.get("query") || undefined, category: url.searchParams.get("category") || undefined,
      offset: Number(url.searchParams.get("offset") || 0), limit: Number(url.searchParams.get("limit") || 24),
    }), summary: catalogSummary() });
    if (action === "detail") {
      const tool = getCatalogTool(url.searchParams.get("name") || "");
      if (!tool) throw new WpsError("TOOL_NOT_FOUND", "没有找到这个 WPS 功能，请先搜索功能目录。", 404);
      return json(tool);
    }
    return json({ error: { code: "NOT_FOUND", message: "页面不存在。" } }, 404);
  } catch (cause) { return errorResponse(cause, action); }
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function keys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new WpsError("INVALID_REQUEST", "请求包含不支持的参数。", 400);
}

export async function POST(request: Request) {
  const action = new URL(request.url).pathname.split("/").pop() || "unknown";
  try {
    const actor = actorFrom(request);
    requireSameOrigin(request, env);
    const value = await readJson(request, action === "token" ? 20_000 : 524_288);
    if (!object(value)) throw new WpsError("INVALID_REQUEST", "请求参数无效。");
    if (action === "acceptance") {
      keys(value, ["suite", "requestId"]);
      return json(await runAcceptance(value.suite, value.requestId, actor, env));
    }
    if (action === "presentation-file") {
      keys(value, ["presentation"]);
      return json(await generatePresentationFile(presentationInput(value.presentation)));
    }
    if (action === "presentation-create") {
      keys(value, ["presentation", "requestId"]);
      return json(await createPresentation(value.presentation, value.requestId, actor, env));
    }
    if (action === "presentation-verify") {
      keys(value, ["presentation", "fileId", "taskId"]);
      return json(await verifyPresentation(value.presentation, value.fileId, value.taskId, actor, env));
    }
    if (action === "poll" || action === "cancel") {
      keys(value, ["attemptId"]);
      if (typeof value.attemptId !== "string") throw new WpsError("INVALID_REQUEST", "请从页面重新发起连接。");
      return json(action === "poll" ? await pollConnection(actor, value.attemptId, env) : await cancelConnection(actor, value.attemptId, env));
    }
    if (action === "token") { keys(value, ["token"]); return json(await importPersonalToken(actor, value.token, env)); }
    if (action === "preview") { keys(value, ["plan"]); return json(await previewWorkflow(value.plan)); }
    if (action === "run") {
      keys(value, ["plan", "requestId"]);
      if (typeof value.requestId !== "string") throw new WpsError("INVALID_REQUEST", "执行请求缺少编号。", 400);
      return json(await runWorkflow(value.plan, actor, env, value.requestId));
    }
    if (action === "call-preview") {
      keys(value, ["tool", "arguments"]);
      if (typeof value.tool !== "string" || !object(value.arguments)) throw new WpsError("INVALID_REQUEST", "请提供功能名与参数。", 400);
      return json(await previewSensitiveCall(value.tool, value.arguments, actor, env));
    }
    if (action === "call") {
      keys(value, ["tool", "arguments", "mode", "reviewToken", "confirmedTool", "requestId"]);
      if (typeof value.tool !== "string" || !object(value.arguments) || !["read", "write", "sensitive"].includes(String(value.mode)))
        throw new WpsError("INVALID_REQUEST", "功能名、参数或操作模式不正确。", 400);
      for (const key of ["reviewToken", "confirmedTool", "requestId"]) if (value[key] !== undefined && typeof value[key] !== "string")
        throw new WpsError("INVALID_REQUEST", "操作凭证格式不正确。", 400);
      return json(await executeCatalogCall(value as { tool: string; arguments: Record<string, unknown>; mode: "read" | "write" | "sensitive"; reviewToken?: string; confirmedTool?: string; requestId?: string }, actor, env));
    }
    keys(value, []);
    if (action === "connect") return json(await beginConnection(actor, env));
    if (action === "verify") return json(await verifyConnection(actor, env));
    if (action === "disconnect") { await service(env).store.disconnect(actor); return json({ disconnected: true }); }
    return json({ error: { code: "NOT_FOUND", message: "操作不存在。" } }, 404);
  } catch (cause) { return errorResponse(cause, action); }
}
