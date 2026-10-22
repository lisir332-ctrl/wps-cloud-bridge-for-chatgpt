type ObjectValue = Record<string, unknown>;
export type WpsTaskState = { state: "returned" | "pending" | "failed" | "uncertain"; notice?: string; taskId?: string };
function object(value: unknown): value is ObjectValue { return !!value && typeof value === "object" && !Array.isArray(value); }
const KNOWN_TOOLS = new Set([
  "read_file", "aippt.execute", "wpp.export.export.pdf", "wps.export", "wps.query_export", "scrape_url", "scrape_progress",
  "pdf.convert", "pdf.convert_query", "pdf.split", "pdf.split_query", "pdf.merge", "pdf.merge_query",
  "pdf.translate_full_file", "pdf.get_translate_progress",
]);
const PENDING = new Set(["pending", "processing", "running", "queued", "generating", "in_progress"]);
const FAILED = new Set(["failed", "failure", "error", "cancelled", "canceled"]);
const COMPLETE = new Set(["success", "done", "completed", "finished"]);
const uncertain = (): WpsTaskState => ({ state: "uncertain", notice:
  "已收到返回，但未识别到此异步工具的明确完成、等待或失败证据。结果不确定；请核对原始结果，不能据此宣告完成或自动重试写入。" });

function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length <= 256 && /^[a-z\d_.:-]+$/i.test(value);
}
function url(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 4096) return false;
  try { const parsed = new URL(value); return parsed.protocol === "https:" && !parsed.username && !parsed.password; }
  catch { return false; }
}
function officialLink(value: unknown) {
  return url(value) && ["wps.cn", "kdocs.cn"].some((domain) => {
    const host = new URL(value).hostname;
    return host === domain || host.endsWith("." + domain);
  });
}
function fileEvidence(value: unknown): boolean {
  return object(value) && (identifier(value.file_id) || identifier(value.wps_yun_fileid) ||
    (typeof value.file_id === "number" && Number.isSafeInteger(value.file_id) && value.file_id > 0) ||
    url(value.download_url) || url(value.url));
}

/** A multi-block MCP fallback is not document content. Read complete JSON blocks
 * only; never search text fragments or recursively walk a document/body field. */
function topLevelBusinessOutput(tool: string, output: unknown): ObjectValue | null {
  if (!object(output)) return null;
  if (Object.keys(output).length !== 1 || !Array.isArray(output.content)) return output;
  const candidates: ObjectValue[] = [];
  for (const block of output.content) {
    if (!object(block) || block.type !== "text" || typeof block.text !== "string") continue;
    let parsed: unknown;
    try { parsed = JSON.parse(block.text) as unknown; } catch { continue; }
    if (!object(parsed)) continue;
    const businessKeys = tool === "read_file" ? ["code", "status", "task_id"]
      : tool === "aippt.execute" ? ["code", "status", "interrupt", "need_interaction", "generation", "delta", "session_id"]
      : tool.startsWith("scrape_") ? ["code", "status", "job_id", "scrape_file_id"]
      : ["code", "status", "task_id", "jobid", "progress", "convert_job", "query_params", "file_info", "result_files", "result", "url", "download_url"];
    if (businessKeys.some((key) => Object.hasOwn(parsed as ObjectValue, key))) candidates.push(parsed);
  }
  return candidates.length === 1 ? candidates[0] : null;
}

/** Only known asynchronous tools receive stricter completion checks. Other
 * tools retain their existing semantics, including arbitrary user JSON data. */
export function inspectWpsTaskState(tool: string, output: unknown): WpsTaskState {
  if (!KNOWN_TOOLS.has(tool)) return { state: "returned" };
  const root = topLevelBusinessOutput(tool, output);
  if (!root) return uncertain();
  let data = root;
  if (Object.hasOwn(root, "code")) {
    if (root.code !== 0 && root.code !== "0") {
      const numeric = typeof root.code === "number" ? root.code
        : typeof root.code === "string" && /^-?\d+$/.test(root.code) ? Number(root.code) : NaN;
      return Number.isFinite(numeric) && numeric !== 0
        ? { state: "failed", notice: "WPS 返回非成功业务代码，请核对已有产物；不能把本次任务当作完成。" } : uncertain();
    }
    if (!object(root.data)) return uncertain();
    data = root.data;
  }
  const rawId = data.task_id ?? data.jobid ?? data.job_id ?? (object(data.convert_job) ? data.convert_job.jobid : undefined) ??
    (object(data.query_params) ? data.query_params.jobid : undefined);
  const taskId = identifier(rawId) ? rawId : undefined;
  const state = (value: "pending" | "failed", notice: string): WpsTaskState => ({ state: value, notice, ...(taskId ? { taskId } : {}) });
  const pending = (notice: string) => state("pending", notice);
  const failed = () => state("failed", "官方任务返回失败或取消状态。请核对已有文件和任务编号，再决定下一步。");

  // Scrape has a documented numeric protocol; do not coerce these fields into
  // the unrelated string statuses used by read/export/convert tools.
  if (tool === "scrape_progress") {
    if (data.status === -1) return failed();
    if (data.status === 1) return (typeof data.scrape_file_id === "number" && Number.isSafeInteger(data.scrape_file_id) && data.scrape_file_id > 0) || officialLink(data.link_url)
      ? { state: "returned" } : uncertain();
    return typeof data.status === "number" && Number.isFinite(data.status)
      ? pending("网页剪藏任务尚未完成。请使用原 job_id 查询 scrape_progress，不要重新提交网页。") : uncertain();
  }
  if (tool === "scrape_url") return identifier(data.job_id)
    ? pending("网页剪藏已建立任务，尚未核实生成文档。请用返回的 job_id 查询 scrape_progress。") : uncertain();

  if (data.status !== undefined && typeof data.status !== "string") return uncertain();
  const status = typeof data.status === "string" ? data.status.toLowerCase() : "";
  if (FAILED.has(status)) return failed();
  if (tool === "read_file") {
    if (PENDING.has(status)) return pending("文档正文尚未就绪。请保留 task_id 与原读取参数，另行执行只读查询；后续步骤没有发出。");
    return status === "ok" && (typeof data.content === "string" || object(data.content)) ? { state: "returned" } : uncertain();
  }
  if (tool === "aippt.execute") {
    const delta = object(data.delta) ? data.delta : undefined;
    if ((object(data.interrupt) && Object.keys(data.interrupt).length > 0) || data.need_interaction === true || delta?.need_interaction === true)
      return pending("AI PPT 正等待本轮确认或输入。请按实际中断信息继续原 session_id，不能把本轮返回当作成片完成。");
    if (PENDING.has(status)) return pending("AI PPT 返回生成中状态。请复用原 session_id 核查，尚不能宣告最终演示文稿完成。");
    // This legacy event is documented. The newer generation object has no
    // published output schema; preserve it for review instead of guessing keys.
    const artifact = delta?.type === "upload_cloud.done" && object(delta.payload) ? delta.payload : undefined;
    return artifact && data.is_partial === false && identifier(artifact.file_id) && officialLink(artifact.link_url)
      ? { state: "returned" } : uncertain();
  }
  if (PENDING.has(status)) return pending("官方任务仍在处理。请使用原任务编号查询结果；本次不会重新提交生成或转换。");
  if (status && status !== "ok" && !COMPLETE.has(status)) return uncertain();
  if (["wpp.export.export.pdf", "wps.export", "wps.query_export"].includes(tool)) {
    if (url(data.url) || url(data.download_url)) return { state: "returned" };
    return taskId && (!status || status === "ok")
      ? pending("导出已建立任务，尚未取得导出文件。请使用原 task_id 查询结果，不要重新提交导出。") : uncertain();
  }
  const progress = typeof data.progress === "number" ? data.progress
    : object(data.file_info) && typeof data.file_info.progress === "number" ? data.file_info.progress : undefined;
  if (progress !== undefined && (!Number.isFinite(progress) || progress < 0 || progress > 100)) return uncertain();
  if (progress !== undefined && progress < 100) return pending("官方任务进度尚未达到 100%，请查询原任务后再使用产物。");
  if (["pdf.translate_full_file", "pdf.get_translate_progress"].includes(tool)) {
    if ((COMPLETE.has(status) || progress === 100) && object(data.result) && Object.keys(data.result).length > 0) return { state: "returned" };
    return tool === "pdf.translate_full_file" && taskId && (!status || status === "ok") && progress === undefined
      ? pending("翻译请求返回了任务编号，尚未取得完成结果。请保留原任务，不要重复提交翻译。") : uncertain();
  }
  if (Array.isArray(data.result_files) && data.result_files.length > 0 && data.result_files.every(fileEvidence)) return { state: "returned" };
  return ["pdf.convert", "pdf.split", "pdf.merge"].includes(tool) && taskId && progress === undefined && (!status || status === "ok")
    ? pending("已建立转换任务，尚无最终产物。请使用原任务编号查询，不要重新提交。") : uncertain();
}
