import { type RuntimeEnv } from "./wps-auth.ts";
import { classifyOperation } from "./wps-catalog.ts";
import { executionHash, repeatExecution, requireRequestId, WpsExecutionLedger } from "./wps-executions.ts";
import { connectionCaller, type GatewayDependencies } from "./wps-gateway.ts";
import { generatePresentationFile, PresentationInputError, validatePresentationInput, type PresentationFile, type ValidatedPresentationInput } from "./wps-presentation-file.ts";
import { WpsError, type McpToolResult } from "./wps-upstream.ts";
import { findExecutableTool, isRecord, isUncertainWrite, outputFromResult, validateCatalogArguments } from "./wps-workflows.ts";

export type PresentationVerification = {
  status: "passed" | "pending" | "failed" | "not_run";
  detail: string;
  taskId?: string;
  error?: { code: string; message: string };
};
export type PresentationTaskResult = {
  status: "succeeded" | "pending" | "failed" | "uncertain";
  requestId: string;
  name: string;
  slideCount: number;
  fileId?: string;
  url?: string;
  verification: PresentationVerification;
  notices: string[];
  error?: { code: string; message: string };
};
type Dependencies = GatewayDependencies & {
  generate?: (input: ValidatedPresentationInput) => Promise<PresentationFile>;
};
type Caller = Awaited<ReturnType<typeof connectionCaller>>;

export function presentationInput(value: unknown): ValidatedPresentationInput {
  try { return validatePresentationInput(value); }
  catch (error) {
    if (error instanceof PresentationInputError) throw new WpsError(error.code, error.message, 400);
    throw new WpsError("PRESENTATION_INPUT_INVALID", "演示提纲格式不正确，请检查标题和每页要点。", 400);
  }
}

function id(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(value))
    throw new WpsError("PRESENTATION_ID_INVALID", `${label}缺少有效的实际编号。`, 400);
  return value;
}
function safeLink(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 1024) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || (url.port && url.port !== "443") ||
      !["wps.cn", "kdocs.cn"].some((domain) => url.hostname === domain || url.hostname.endsWith("." + domain))) return undefined;
    return url.href;
  } catch { return undefined; }
}
function safeError(error: unknown) {
  return error instanceof WpsError ? { code: error.code, message: error.message }
    : { code: "PRESENTATION_ERROR", message: "演示处理未取得完整结果。若已发出上传，请先核对云文件，再决定下一步。" };
}
function dataFrom(result: McpToolResult) {
  if (result.isError) throw new WpsError("PRESENTATION_UPSTREAM_ERROR", "WPS 未确认此次操作成功。", 502);
  const output = outputFromResult(result);
  if (!isRecord(output) || (output.code !== 0 && output.code !== "0") || !isRecord(output.data))
    throw new WpsError("PRESENTATION_RESPONSE_UNRECOGNIZED", "WPS 返回的结构与已核实协议不一致，不能据此认定完成。", 502);
  return output.data;
}
async function call(caller: Caller, toolName: string, args: Record<string, unknown>, operation: "read" | "write") {
  const tool = findExecutableTool(toolName);
  validateCatalogArguments(tool, args);
  if (classifyOperation(tool, args) !== operation)
    throw new WpsError("PRESENTATION_TOOL_CHANGED", "演示工具的操作分类已变化，已停止调用。", 409);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      caller.callTool(toolName, args),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new WpsError("UPSTREAM_TIMEOUT",
        "WPS 尚未在时限内返回结果。已发出的请求仍可能完成，请保留原编号并先核对文件。", 504)), 30_000); }),
    ]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

const normalized = (value: string) => value.normalize("NFC").replace(/\s+/gu, " ").trim();

/** Only reads the documented KDC slide/textbox structure; never executes text. */
function verifyKdc(data: Record<string, unknown>, input: ValidatedPresentationInput, fileId: string): PresentationVerification {
  if (data.status === "pending") {
    const taskId = id(data.task_id, "读取任务");
    return { status: "pending", taskId, detail: "PPT 已上传，WPS 仍在抽取内容。请用本次任务编号继续只读核对，不要再次上传。" };
  }
  if (data.status !== "ok" || data.content_format !== "kdc" || !isRecord(data.content) || !Array.isArray(data.content.slide_containers))
    return { status: "not_run", detail: "尚未收到可核对的完整演示结构。文件可能已存在，请打开成品检查。" };
  if (data.file_id !== fileId)
    return { status: "failed", detail: "读取结果的文件编号与本次上传文件不一致，未将其视为通过。" };
  if (data.warnings !== undefined && (!Array.isArray(data.warnings) || data.warnings.length > 0))
    return { status: "not_run", detail: "WPS 返回了读取范围或内容提示，无法据此确认所有页面文字完整。" };
  const containers = data.content.slide_containers.filter((container) => isRecord(container) && container.category === "slides");
  if (!containers.length || containers.some((container) => !Array.isArray(container.slides)))
    return { status: "not_run", detail: "读取结果缺少已核实的页面列表结构，未将其视为通过。" };
  const slides = containers.flatMap((container) => container.slides as unknown[]);
  if (slides.length !== input.slides.length)
    return { status: "failed", detail: `实际读取到 ${slides.length} 页，与提纲的 ${input.slides.length} 页不一致。` };
  for (const [index, slide] of slides.entries()) {
    if (!isRecord(slide) || !Array.isArray(slide.shape_tree))
      return { status: "not_run", detail: `第 ${index + 1} 页未返回可核对的文本框结构。` };
    const textboxes: string[] = [];
    for (const shape of slide.shape_tree) {
      if (!isRecord(shape) || shape.type !== "textbox") continue;
      if (!isRecord(shape.textbox) || !Array.isArray(shape.textbox.blocks))
        return { status: "not_run", detail: `第 ${index + 1} 页的文本框格式尚不能核对。` };
      const paragraphs: string[] = [];
      for (const block of shape.textbox.blocks) {
        if (!isRecord(block) || !isRecord(block.para) || !Array.isArray(block.para.runs) ||
          block.para.runs.some((run) => !isRecord(run) || typeof run.text !== "string"))
          return { status: "not_run", detail: `第 ${index + 1} 页的文字内容结构尚不能核对。` };
        paragraphs.push(block.para.runs.map((run) => (run as { text: string }).text).join(""));
      }
      textboxes.push(normalized(paragraphs.join("\n")));
    }
    // Match a multiset, so a footer or duplicate bullet cannot substitute for a missing textbox.
    const expected = [input.slides[index].title, ...input.slides[index].bullets, input.title, `${index + 1} / ${input.slides.length}`];
    for (const text of expected) {
      const position = textboxes.indexOf(normalized(text));
      if (position < 0) return { status: "failed", detail: `第 ${index + 1} 页的标题、要点或页脚与生成提纲不一致，请打开文件核对。` };
      textboxes.splice(position, 1);
    }
  }
  return { status: "passed", detail: `已回读核对 ${slides.length} 页的标题、每条要点和页脚；字体、换行与视觉效果仍需打开成品确认。` };
}

async function verifyWithCaller(input: ValidatedPresentationInput, fileId: string, taskId: string | undefined, caller: Caller): Promise<PresentationVerification> {
  try {
    const result = await call(caller, "read_file", { file_id: fileId, format: "kdc", enable_upload_medias: false,
      ...(taskId ? { task_id: taskId } : {}) }, "read");
    return verifyKdc(dataFrom(result), input, fileId);
  } catch (error) {
    return { status: "not_run", detail: "本次未能完成只读核对；这不会重新上传或覆盖文件。", error: safeError(error) };
  }
}

/** Read-only continuation. It never uploads, replaces, shares or creates a file. */
export async function verifyPresentation(input: unknown, fileIdValue: unknown, taskIdValue: unknown, actor: string, env: RuntimeEnv, deps: GatewayDependencies = {}): Promise<PresentationVerification> {
  const validated = presentationInput(input);
  const fileId = id(fileIdValue, "PPT 文件");
  const taskId = taskIdValue === undefined ? undefined : id(taskIdValue, "读取任务");
  const caller = await connectionCaller(actor, env, deps);
  return verifyWithCaller(validated, fileId, taskId, caller);
}

/** Atomically claims the logical outline before generating bytes or creating one new file. */
export async function createPresentation(input: unknown, requestId: unknown, actor: string, env: RuntimeEnv, deps: Dependencies = {}) {
  const validated = presentationInput(input);
  const request = requireRequestId(requestId);
  if (!env.DB) throw new WpsError("SERVICE_NOT_READY", "执行登记数据库尚未就绪，本次未调用 WPS。", 503);
  const caller = await connectionCaller(actor, env, deps);
  const ledger = new WpsExecutionLedger(env.DB);
  const hash = await executionHash({ kind: "presentation-v1", input: validated });
  const claim = await ledger.claim(actor, request, hash);
  if (!claim.claimed) return repeatExecution(claim.record);
  const result: PresentationTaskResult = { status: "failed", requestId: request,
    name: `${validated.title}.pptx`, slideCount: validated.slides.length,
    verification: { status: "not_run", detail: "尚未取得新建 PPT 文件编号。" },
    notices: ["本操作新建一份 PPTX，未覆盖已有文件。读回检查不能替代成品的视觉检查。"] };
  let uploadStarted = false;
  try {
    const file = await (deps.generate ?? generatePresentationFile)(validated);
    const args = { name: file.name, content_base64: file.contentBase64, content_format: "pptx" };
    // Validate before declaring that a write may have been sent.
    validateCatalogArguments(findExecutableTool("upload_new_file"), args);
    uploadStarted = true;
    const uploaded = dataFrom(await call(caller, "upload_new_file", args, "write"));
    result.fileId = id(uploaded.id, "上传文件");
    result.url = safeLink(uploaded.link_url);
    result.verification = await verifyWithCaller(validated, result.fileId, undefined, caller);
    result.status = result.verification.status === "passed" ? "succeeded" : result.verification.status === "pending" ? "pending"
      : result.verification.status === "failed" ? "failed" : "uncertain";
    if (result.verification.error) result.error = result.verification.error;
    if (result.status !== "succeeded") result.notices.push("上传已返回文件编号；核对未通过或仍在等待时，不要重新创建同一份文件。");
  } catch (error) {
    result.status = uploadStarted && isUncertainWrite(error, "write") ? "uncertain" : "failed";
    result.error = safeError(error);
    if (error instanceof WpsError && isRecord(error.partialResult) && isRecord(error.partialResult.data)) {
      const partial = error.partialResult.data;
      try { result.fileId = id(partial.id ?? partial.file_id, "部分创建文件"); } catch { /* No valid ID was provided. */ }
      result.url = safeLink(partial.link_url);
    }
    if (uploadStarted) result.notices.push("上传请求可能已被 WPS 接收。本服务不会自动重传，请先按文件名或已返回的编号核对。");
  }
  await ledger.finish(actor, request, result.status).catch(() => {
    result.notices.push("执行状态登记未能更新，原请求编号仍被保留，不会再次上传。");
  });
  return result;
}
