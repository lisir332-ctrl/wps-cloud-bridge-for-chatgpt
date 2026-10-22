import { listAcceptanceReports, runAcceptance } from "./wps-acceptance.ts";
import { type RuntimeEnv } from "./wps-auth.ts";
import { createPresentation, verifyPresentation } from "./wps-presentation-task.ts";
import { WpsError, type McpToolResult } from "./wps-upstream.ts";
import { boundedJson, isRecord } from "./wps-workflows.ts";

const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const request = { type: "string", description: "生成一个 UUID v4，重试同一次保存必须保留原编号，不得换编号自动重新上传。" };
const readonly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const creation = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const presentation = object({
  title: { type: "string", minLength: 1, maxLength: 48, description: "普通文件标题，不含扩展名、路径或HTML。" },
  theme: { type: "string", enum: ["forest", "ink"], default: "forest" },
  slides: { type: "array", minItems: 1, maxItems: 12, items: object({
    title: { type: "string", minLength: 1, maxLength: 32 },
    bullets: { type: "array", minItems: 1, maxItems: 5, items: { type: "string", minLength: 1, maxLength: 60 } },
  }, ["title", "bullets"]) },
}, ["title", "slides"]);

export function taskTools() { return [
  { name: "wps_acceptance_status", title: "读取已保存的 WPS 任务验收报告",
    description: "只读取当前用户四套基础验收的已保存证据，不执行 WPS 操作。connectionCurrent=false 的旧报告不能证明当前账号可用；passed 不包含标为 skipped 的视觉、发布或填写检查。",
    inputSchema: object({}), annotations: readonly },
  { name: "wps_run_acceptance", title: "新建测试文件并验收 WPS 基础读写",
    description: "在用户授权测试后，按套件新建独立测试 DOCX/XLSX/PPTX 或未发布问卷，写入后读回并核对实际内容。仅操作本次新建对象；不修改已有文档，不发布问卷。会留下测试文件，基础通过不等于全部 WPS 功能或视觉质量通过。同UUID不会重新执行；pending/uncertain须先核对。",
    inputSchema: object({ suite: { type: "string", enum: ["document", "spreadsheet", "presentation", "form"] }, request_id: request }, ["suite", "request_id"]), annotations: creation },
  { name: "wps_create_presentation", title: "从提纲制作可编辑 PPTX 并保存到 WPS",
    description: "用固定16:9主题生成标准可编辑PPTX，在当前个人WPS新建一个文件，随后回读逐页文字。支持1–12页；每页标题和1–5条纯文本要点。不自动覆盖、分享或发布。返回fileId和verification；pending保留taskId并用wps_verify_presentation继续只读核对；视觉效果仍需打开成品检查。",
    inputSchema: object({ presentation, request_id: request }, ["presentation", "request_id"]), annotations: creation },
  { name: "wps_verify_presentation", title: "继续只读核对已上传的 PPT",
    description: "使用原次生成提纲、实际file_id和本次pending返回的task_id，继续读取KDC结构并核对页数、逐页标题和要点。只读，不生成、不上传、不覆盖文件。pending时保留新taskId；passed后不再用旧taskId。未知结构或读取失败不能声称通过。",
    inputSchema: object({ presentation, file_id: { type: "string", minLength: 1, maxLength: 256 }, task_id: { type: "string", minLength: 1, maxLength: 256 } }, ["presentation", "file_id"]), annotations: readonly },
]; }

export async function executeTaskTool(name: string, input: unknown, actor: string, env: RuntimeEnv): Promise<McpToolResult | null> {
  if (!taskTools().some((tool) => tool.name === name)) return null;
  boundedJson(input);
  if (!isRecord(input)) throw new WpsError("INVALID_ARGUMENTS", "工具参数必须是 JSON 对象。", 400);
  const allowed = name === "wps_acceptance_status" ? [] : name === "wps_run_acceptance" ? ["suite", "request_id"]
    : name === "wps_create_presentation" ? ["presentation", "request_id"] : ["presentation", "file_id", "task_id"];
  if (Object.keys(input).some((key) => !allowed.includes(key))) throw new WpsError("INVALID_ARGUMENTS", "工具参数包含不支持的字段。", 400);
  const value = name === "wps_acceptance_status" ? await listAcceptanceReports(actor, env)
    : name === "wps_run_acceptance" ? await runAcceptance(input.suite, input.request_id, actor, env)
    : name === "wps_create_presentation" ? await createPresentation(input.presentation, input.request_id, actor, env)
    : await verifyPresentation(input.presentation, input.file_id, input.task_id, actor, env);
  return { content: [{ type: "text", text: JSON.stringify(value) }],
    ...(isRecord(value) && "status" in value && ["failed", "uncertain", "not_run", "unknown_after_timeout"].includes(String(value.status)) ? { isError: true } : {}) };
}
