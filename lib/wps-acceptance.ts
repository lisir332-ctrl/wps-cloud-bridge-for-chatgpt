import { type RuntimeEnv } from "./wps-auth.ts";
import { classifyOperation } from "./wps-catalog.ts";
import { requireRequestId } from "./wps-executions.ts";
import { connectionCaller, type GatewayDependencies } from "./wps-gateway.ts";
import { WpsStore, type Connection } from "./wps-store.ts";
import { WpsError, type McpToolResult } from "./wps-upstream.ts";
import { findExecutableTool, isRecord, outputFromResult, validateCatalogArguments } from "./wps-workflows.ts";

export type AcceptanceSuite = "document" | "spreadsheet" | "presentation" | "form";
export type AcceptanceStatus = "running" | "passed" | "failed" | "pending" | "uncertain";
export type AcceptanceCheck = {
  id: string; title: string; status: "pending" | "passed" | "failed" | "skipped" | "uncertain"; detail: string;
};
export type AcceptanceArtifact = { fileId?: string; formId?: string; taskId?: string; url?: string; name: string };
export type AcceptanceReport = {
  id: string; suite: AcceptanceSuite; status: AcceptanceStatus; startedAt: number; updatedAt: number;
  connectionCurrent: boolean; checks: AcceptanceCheck[]; artifacts: AcceptanceArtifact[];
  error?: { code: string; message: string };
};
type Args = Record<string, unknown>;
type StoredReport = Omit<AcceptanceReport, "connectionCurrent">;
type RunRow = {
  user_id: string; request_id: string; suite: AcceptanceSuite; connection_id: string;
  status: AcceptanceStatus; started_at: number; updated_at: number;
  checks_json: string; artifacts_json: string; error_json: string | null;
};
const SUITES: AcceptanceSuite[] = ["document", "spreadsheet", "presentation", "form"];
const RUN_MS = 75_000;
const CALL_MS = 30_000;
const STALE_MS = RUN_MS + 5_000;
const NAMES: Record<AcceptanceSuite, string> = {
  document: "云端验收文档", spreadsheet: "云端验收表格", presentation: "云端验收演示", form: "云端验收问卷",
};
const CHECKS: Record<AcceptanceSuite, [string, string][]> = {
  document: [["create", "创建独立 DOCX 测试文档"], ["initial_read", "回读核对初始文本"],
    ["locate", "精确定位待修改段落"], ["edit", "更新已核对的段落"], ["paragraph", "回读核对修改后的段落"],
    ["content", "核对替换结果及保护段落"]],
  spreadsheet: [["create", "创建独立 XLSX 测试表格"], ["sheet", "读取实际工作表 ID"],
    ["initial_read", "核对表头与初始数据"], ["edit", "写入 D2 公式"], ["values", "回读核对计算值和相邻单元格"],
    ["formula", "核对公式表达式仍然保留"]],
  presentation: [["create", "创建独立 PPTX 测试演示"], ["slide", "插入测试页并取得实际页 ID"],
    ["textbox", "插入测试文本框"], ["shapes", "回读核对文本框 ID"], ["text", "逐字核对文本框内容"],
    ["slides", "回读核对测试页仍然存在"]],
  form: [["create", "创建未发布的问卷草稿"], ["draft", "回读核对草稿 ID 和未发布状态"],
    ["questions", "核对题目类型、标题及选项"]],
};

class AcceptanceStop extends Error {
  constructor(readonly status: Exclude<AcceptanceStatus, "running" | "passed">, readonly code: string, message: string) {
    super(message);
  }
}
function stop(status: AcceptanceStop["status"], code: string, message: string): never {
  throw new AcceptanceStop(status, code, message);
}
function evidence(condition: unknown, detail: string): asserts condition {
  if (!condition) stop("uncertain", "ACCEPTANCE_EVIDENCE_MISSING", detail);
}
function matches(condition: unknown, detail: string): asserts condition {
  if (!condition) stop("failed", "ACCEPTANCE_MISMATCH", detail);
}
function object(value: unknown, detail = "返回结构与已核实的官方格式不同，无法判定验收通过。"): Args {
  evidence(isRecord(value), detail);
  return value;
}
function identifier(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(value) ? value : undefined;
}
function numericId(value: unknown): number {
  evidence(typeof value === "number" && Number.isSafeInteger(value) && value >= 0, "未返回可核对的数值 ID，后续步骤没有发起。");
  return value;
}
function suiteValue(value: unknown): AcceptanceSuite {
  if (typeof value !== "string" || !SUITES.includes(value as AcceptanceSuite))
    throw new WpsError("INVALID_ACCEPTANCE_SUITE", "请选择文档、表格、演示或问卷验收。", 400);
  return value as AcceptanceSuite;
}
function database(env: RuntimeEnv): D1Database {
  if (!env.DB) throw new WpsError("SERVICE_NOT_READY", "验收记录数据库尚未就绪，本次未调用 WPS。", 503);
  return env.DB;
}
function unpack(row: RunRow): StoredReport {
  return { id: row.request_id, suite: row.suite, status: row.status, startedAt: row.started_at, updatedAt: row.updated_at,
    checks: JSON.parse(row.checks_json) as AcceptanceCheck[], artifacts: JSON.parse(row.artifacts_json) as AcceptanceArtifact[],
    ...(row.error_json ? { error: JSON.parse(row.error_json) as NonNullable<StoredReport["error"]> } : {}) };
}
function currentConnection(connection: Connection | null, connectionId: string, now: number) {
  return !!connection && connection.connection_id === connectionId && !connection.expired &&
    (connection.expires_at === null || connection.expires_at > now);
}
function publicReport(report: StoredReport, connectionId: string, connection: Connection | null, now: number): AcceptanceReport {
  const result = structuredClone(report);
  if (result.status === "running" && now - result.startedAt >= STALE_MS) {
    result.status = "uncertain";
    result.error = { code: "ACCEPTANCE_INTERRUPTED", message: "本次运行未在时限内保存完整结果。已发出的修改可能完成，请先核对测试文件；重复提交原编号不会重写。" };
    for (const check of result.checks) if (check.status === "pending") {
      check.status = check.detail === "尚未开始。" ? "skipped" : "uncertain";
      check.detail = check.status === "skipped" ? "没有已保存的执行证据，不视为通过。" : result.error.message;
    }
  }
  return { ...result, connectionCurrent: currentConnection(connection, connectionId, now) };
}
async function getRow(db: D1Database, actor: string, id: string) {
  return db.prepare("SELECT * FROM wps_acceptance_runs WHERE user_id=? AND request_id=?").bind(actor, id).first<RunRow>();
}
async function viewRow(row: RunRow, env: RuntimeEnv, now = Date.now()) {
  return publicReport(unpack(row), row.connection_id, await new WpsStore(database(env)).getConnection(row.user_id), now);
}

/** GET only reads saved evidence. It never polls WPS, resumes, or retries a write. */
export async function listAcceptanceReports(actor: string, env: RuntimeEnv): Promise<{ reports: AcceptanceReport[] }> {
  const db = database(env);
  const connection = await new WpsStore(db).getConnection(actor);
  const rows = await Promise.all(SUITES.map((suite) => db.prepare(
    "SELECT * FROM wps_acceptance_runs WHERE user_id=? AND suite=? ORDER BY started_at DESC, rowid DESC LIMIT 1",
  ).bind(actor, suite).first<RunRow>()));
  const now = Date.now();
  return { reports: rows.filter((row): row is RunRow => !!row).map((row) => publicReport(unpack(row), row.connection_id, connection, now)) };
}

function safeLink(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 1024) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") || url.search || url.hash ||
      !["wps.cn", "kdocs.cn"].some((domain) => url.hostname === domain || url.hostname.endsWith("." + domain))) return undefined;
    return url.href;
  } catch { return undefined; }
}
function payload(output: Args): Args {
  if (Object.hasOwn(output, "code")) {
    evidence(output.code === 0 || output.code === "0", "WPS 未返回明确成功的业务代码，不能作为通过证据。");
    return object(output.data);
  }
  return output;
}
function pairCode(output: Args) {
  evidence(output.code === 0 || output.code === "0", "该写入未返回明确的业务确认，仍需先核对测试文件。");
}
function readText(output: Args, fileId: string) {
  const data = payload(output);
  evidence(data.status === "ok" && typeof data.content === "string", "文档正文尚无可验证的完整读取结果。");
  matches(data.file_id === fileId, "回读文件 ID 与本次新建文件不一致，验收已停止。");
  evidence(!Array.isArray(data.warnings) || data.warnings.length === 0, "WPS 提示读取范围或内容有限，不能据此认定全文验收通过。");
  return data.content;
}
function paragraph(output: Args) {
  const value = payload(output).content;
  evidence(typeof value === "string", "未返回可核对的段落正文。");
  return value.endsWith("\r") ? value.slice(0, -1) : value;
}

class Runner {
  private activeCheck: AcceptanceCheck | undefined;
  constructor(readonly report: StoredReport, readonly actor: string, readonly connectionId: string,
    readonly db: D1Database, readonly callTool: (tool: string, args: Args) => Promise<McpToolResult>, readonly clock: () => number) {}

  async save() {
    this.report.updatedAt = this.clock();
    try {
      const result = await this.db.prepare(
        "UPDATE wps_acceptance_runs SET status=?, updated_at=?, checks_json=?, artifacts_json=?, error_json=? " +
        "WHERE user_id=? AND request_id=? AND connection_id=? AND status='running'",
      ).bind(this.report.status, this.report.updatedAt, JSON.stringify(this.report.checks), JSON.stringify(this.report.artifacts),
        this.report.error ? JSON.stringify(this.report.error) : null, this.actor, this.report.id, this.connectionId).run();
      if (result.meta.changes !== 1) throw new Error("Not running");
    } catch { stop("uncertain", "ACCEPTANCE_SAVE_FAILED", "验收摘要保存中断。后续步骤不会继续，已发出的修改请先在测试文件中核对。"); }
  }

  async step<T>(id: string, detail: string, action: () => Promise<T>): Promise<T> {
    const check = this.report.checks.find((item) => item.id === id)!;
    this.activeCheck = check;
    check.detail = "正在执行并核对实际结果。";
    await this.save();
    if (this.clock() - this.report.startedAt >= RUN_MS)
      stop("uncertain", "ACCEPTANCE_TIME_BUDGET", "本次验收时间已达上限，后续操作没有发起。已创建的文件和已通过的检查保留在报告中。");
    const result = await action();
    check.status = "passed";
    check.detail = detail;
    await this.save();
    return result;
  }

  async capture(tool: string, output: unknown) {
    if (!isRecord(output)) return;
    const data = isRecord(output.data) ? output.data : output;
    let artifact = this.report.artifacts[0];
    const fileId = tool === "create_file_with_content" ? identifier(data.file_id)
      : tool === "create_empty_file" ? identifier(data.id) : undefined;
    const formId = tool === "form.lite.create_draft" ? identifier(data.form_id) : undefined;
    const taskId = identifier(data.task_id);
    if (!fileId && !formId && !taskId) return;
    if (!artifact) { artifact = { name: NAMES[this.report.suite] + "-" + this.report.id }; this.report.artifacts.push(artifact); }
    if (fileId) artifact.fileId = fileId;
    if (formId) { artifact.formId = formId; artifact.url = "https://f.wps.cn/ksform/m/result/" + formId; }
    if (taskId) artifact.taskId = taskId;
    if (fileId) { const url = safeLink(data.link_url); if (url) artifact.url = url; }
    await this.save();
  }

  async call(toolName: string, args: Args): Promise<Args> {
    const tool = findExecutableTool(toolName);
    validateCatalogArguments(tool, args);
    const operation = classifyOperation(tool, args);
    if (operation === "sensitive") stop("failed", "ACCEPTANCE_UNSAFE_RECIPE", "该步骤被识别为敏感操作，验收不会执行。");
    if (typeof args.file_id === "string" && !this.report.artifacts.some((item) => item.fileId === args.file_id))
      stop("failed", "ACCEPTANCE_TARGET_REJECTED", "验收只允许访问本次新建的测试文件。");
    if (typeof args.form_id === "string" && !this.report.artifacts.some((item) => item.formId === args.form_id))
      stop("failed", "ACCEPTANCE_TARGET_REJECTED", "验收只允许访问本次新建的问卷草稿。");
    const remaining = RUN_MS - (this.clock() - this.report.startedAt);
    if (remaining <= 0) stop("uncertain", "ACCEPTANCE_TIME_BUDGET", "本次验收时间已达上限，后续操作没有发起。");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // A deadline is not cancellation of an already accepted WPS operation.
      // Never retry, and never execute a following step after this race times out.
      const result = await Promise.race([
        this.callTool(tool.name, args),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new AcceptanceStop("uncertain", "ACCEPTANCE_CALL_TIMEOUT",
          "本次请求未在时限内返回，已发出的修改可能仍会完成。验收已停止，不会自动重试。")), Math.min(CALL_MS, remaining)); }),
      ]);
      const output = outputFromResult(result);
      await this.capture(tool.name, output);
      if (result.isError) stop(operation === "read" ? "failed" : "uncertain", "WPS_TOOL_ERROR", "WPS 返回工具错误，未通过验收；已创建的测试文件仍需核对。");
      const envelope = object(output);
      if (Object.hasOwn(envelope, "code") && envelope.code !== 0 && envelope.code !== "0")
        stop(operation === "read" ? "failed" : "uncertain", "WPS_BUSINESS_ERROR", "WPS 业务请求未成功，不能认定验收通过；修改可能部分生效。");
      const business = isRecord(envelope.data) ? envelope.data : envelope;
      if (typeof business.status === "string" && ["pending", "processing", "running", "queued", "in_progress"].includes(business.status))
        stop("pending", "WPS_TASK_PENDING", "WPS 仍在处理异步任务。本次验收已停止，文件及任务编号已保留；刷新报告不会重发或继续写入。");
      if (this.clock() - this.report.startedAt >= RUN_MS)
        stop("uncertain", "ACCEPTANCE_TIME_BUDGET", "结果返回时验收已达时限，后续操作没有发起。请核对已保存的测试文件。");
      return envelope;
    } catch (error) {
      if (error instanceof WpsError && error.partialResult) await this.capture(tool.name, error.partialResult);
      throw error;
    } finally { if (timer !== undefined) clearTimeout(timer); }
  }

  fail(error: unknown) {
    const failure = error instanceof AcceptanceStop ? error : error instanceof WpsError
      ? new AcceptanceStop(["NOT_CONNECTED", "WPS_AUTH_EXPIRED", "CONNECTION_CHANGED", "WPS_FORBIDDEN", "WPS_PERSONAL_ACCOUNT_REQUIRED", "INVALID_ARGUMENTS"].includes(error.code) ? "failed" : "uncertain",
        /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : "ACCEPTANCE_ERROR",
        ["NOT_CONNECTED", "WPS_AUTH_EXPIRED", "CONNECTION_CHANGED"].includes(error.code)
          ? "WPS 连接已断开、失效或更改，后续步骤没有发起。报告只对应发起验收时的连接。"
          : "WPS 请求未取得可确认的结果。本次验收已停止，请核对已创建的测试文件，不会自动重试写入。")
      : new AcceptanceStop("uncertain", "ACCEPTANCE_ERROR", "验收意外中断。已发出的修改可能完成，请核对报告中的测试文件；不会自动重试写入。");
    this.report.status = failure.status;
    this.report.error = { code: failure.code, message: failure.message };
    if (this.activeCheck) { this.activeCheck.status = failure.status; this.activeCheck.detail = failure.message; }
    for (const check of this.report.checks) if (check !== this.activeCheck && check.status === "pending") {
      check.status = "skipped"; check.detail = "前序检查未完成，本步骤没有发起。";
    }
  }
}

function recipeCalls(suite: AcceptanceSuite, name: string): [string, Args][] {
  const file_id = "acceptance-preflight-only";
  if (suite === "document") return [
    ["create_file_with_content", { name, file_extension: "docx", content: "预检" }],
    ["read_file", { file_id, format: "plain", enable_upload_medias: false }],
    ["wps.texts.content", { file_id, scope: "paragraphs", verb: "query", paragraph_index: 1 }],
    ["wps.texts.content", { file_id, scope: "paragraphs", verb: "update", paragraph_index: 1, content: "预检" }],
  ];
  if (suite === "spreadsheet") return [
    ["create_file_with_content", { name, file_extension: "xlsx", sheet_name: "验收", rangeData: [{ row_from: 0, row_to: 1, col_from: 0, col_to: 3, formula: INITIAL_CELLS }] }],
    ["sheet.get_sheets_info", { file_id }], ["sheet.get_range_data", { file_id, worksheet_id: 1, range: CELL_RANGE }],
    ["sheet.range_data_batch_update", { file_id, worksheet_id: 1, range_data: [{ op_type: "cell_operation_type_formula", row_from: 1, row_to: 1, col_from: 3, col_to: 3, formula: "=B2*C2" }] }],
  ];
  if (suite === "presentation") return [
    ["create_empty_file", { name, file_extension: "pptx", on_name_conflict: "fail" }],
    ["wpp.slide.items.insert", { file_id, index: 1, layout: 1 }],
    ["wpp.shape.items.textboxes", { file_id, slide_id: 1, textboxes: [{ text: "预检", left: 36, top: 80, width: 640, height: 70 }] }],
    ["wpp.shape.items.list", { file_id, slide_id: 1 }],
    ["wpp.shape.texts.text", { file_id, slide_id: 1, shape_id: 1, verb: "query" }], ["wpp.slide.items.list", { file_id }],
  ];
  return [["form.lite.create_draft", { title: name, questions: FORM_QUESTIONS }], ["form.lite.get_form_info", { form_id: file_id }]];
}

async function documentRecipe(r: Runner, name: string) {
  const source = "WPS 验收原文 " + r.report.id;
  const replacement = "WPS 验收已更新 " + r.report.id;
  const guard = "WPS 验收保护段落 " + r.report.id;
  const fileId = await r.step("create", "新建文件返回了有效文件 ID；该 ID 已保存。", async () => {
    const out = await r.call("create_file_with_content", { name, file_extension: "docx", content: source + "\n\n" + guard });
    pairCode(out); const id = identifier(payload(out).file_id); evidence(id, "新建请求未返回可核对的文件 ID，后续步骤没有发起。"); return id;
  });
  const readArgs = { file_id: fileId, format: "plain", enable_upload_medias: false };
  await r.step("initial_read", "同一新文件的原始标记和保护段落均已回读。", async () => {
    const text = readText(await r.call("read_file", readArgs), fileId);
    matches(text.includes(source) && text.includes(guard), "新文档回读内容缺少预期标记，后续修改未发起。");
  });
  const query = { file_id: fileId, scope: "paragraphs", verb: "query", paragraph_index: 1 };
  await r.step("locate", "第一段逐字匹配本次原文标记，允许在该新文件内修改。", async () => {
    matches(paragraph(await r.call("wps.texts.content", query)) === source, "目标段落未精确匹配原文，验收不会猜测其他位置或修改内容。");
  });
  await r.step("edit", "目标段落更新请求已取得业务确认，仍须后续回读核对。", async () => {
    pairCode(await r.call("wps.texts.content", { ...query, verb: "update", content: replacement }));
  });
  await r.step("paragraph", "目标段落逐字匹配更新后的标记。", async () => {
    matches(paragraph(await r.call("wps.texts.content", query)) === replacement, "更新后的目标段落与预期不同。");
  });
  await r.step("content", "全文回读含新标记、不含旧标记，保护段落仍保留。", async () => {
    const text = readText(await r.call("read_file", readArgs), fileId);
    matches(text.includes(replacement) && !text.includes(source) && text.includes(guard), "全文回读未同时满足新标记、旧标记移除和保护段落保留三项要求。");
  });
}

const INITIAL_CELLS = [["项目", "数量", "单价", "金额"], ["验收项", "2", "3", ""]];
const CELL_RANGE = { rowFrom: 0, rowTo: 1, colFrom: 0, colTo: 3 };
function cells(output: Args) {
  const body = payload(output);
  evidence(body.result === "ok", "未返回明确成功的表格读取状态。");
  const rows = object(body.detail).rangeData;
  evidence(Array.isArray(rows), "未返回可按坐标核对的单元格列表。");
  const map = new Map<string, Args>();
  for (const value of rows) {
    const cell = object(value);
    evidence(typeof cell.rowFrom === "number" && typeof cell.colFrom === "number", "单元格缺少明确的行列坐标。");
    const key = cell.rowFrom + ":" + cell.colFrom;
    evidence(!map.has(key), "返回了重复的单元格坐标，无法可靠核对。");
    map.set(key, cell);
  }
  return map;
}
function checkProtectedCells(map: Map<string, Args>) {
  for (let row = 0; row < 2; row++) for (let col = 0; col < 4; col++) if (row !== 1 || col !== 3) {
    const cell = map.get(row + ":" + col);
    evidence(cell && (typeof cell.cellText === "string" || typeof cell.cellText === "number"), "回读缺少必需的相邻单元格证据。");
    matches(String(cell.cellText) === INITIAL_CELLS[row][col], "表头或相邻数据与初始值不一致。");
  }
}
async function spreadsheetRecipe(r: Runner, name: string) {
  const create = recipeCalls("spreadsheet", name)[0];
  const fileId = await r.step("create", "新建 XLSX 返回了有效文件 ID；该 ID 已保存。", async () => {
    const out = await r.call(...create); pairCode(out); const id = identifier(payload(out).file_id);
    evidence(id, "新建表格未返回有效文件 ID。"); return id;
  });
  const worksheetId = await r.step("sheet", "从实际工作表列表匹配“验收”，使用返回的 sheetId。", async () => {
    const data = payload(await r.call("sheet.get_sheets_info", { file_id: fileId }));
    const info = Array.isArray(data.sheetsInfo) ? data.sheetsInfo : isRecord(data.detail) ? data.detail.sheetsInfo : undefined;
    evidence(Array.isArray(info), "工作表列表结构未能核实，不能猜测工作表 ID。");
    const found = info.filter((item) => isRecord(item) && item.sheetName === "验收");
    matches(found.length === 1, "未唯一匹配本次新建的“验收”工作表。");
    return numericId(object(found[0]).sheetId);
  });
  const rangeArgs = { file_id: fileId, worksheet_id: worksheetId, range: CELL_RANGE };
  await r.step("initial_read", "A1:D1 表头和 A2:C2 数据均与预期一致。", async () => { checkProtectedCells(cells(await r.call("sheet.get_range_data", rangeArgs))); });
  await r.step("edit", "只向该新表格 D2 写入公式；仍须回读结果和表达式。", async () => {
    pairCode(await r.call("sheet.range_data_batch_update", { file_id: fileId, worksheet_id: worksheetId,
      range_data: [{ op_type: "cell_operation_type_formula", row_from: 1, row_to: 1, col_from: 3, col_to: 3, formula: "=B2*C2" }] }));
  });
  const result = await r.step("values", "D2 显示计算结果 6，表头和相邻七个单元格保持原值。", async () => {
    const map = cells(await r.call("sheet.get_range_data", rangeArgs)); checkProtectedCells(map);
    const cell = map.get("1:3"); evidence(cell && (typeof cell.cellText === "number" || typeof cell.cellText === "string"), "未返回 D2 的实际显示值。");
    matches(String(cell.cellText).trim() !== "" && Number(cell.cellText) === 6, "D2 的实际显示值不等于 6。"); return cell;
  });
  await r.step("formula", "D2 回读的公式表达式为 =B2*C2，已确认没有仅保存计算常量。", async () => {
    const formula = typeof result.fmlaText === "string" ? result.fmlaText
      : typeof result.originalCellValue === "string" && result.originalCellValue.startsWith("=") ? result.originalCellValue : undefined;
    evidence(formula, "D2 数值虽已回读，但未返回公式表达式，无法确认公式保留。");
    matches(formula.replace(/\s/g, "").toUpperCase() === "=B2*C2", "D2 实际公式表达式与预期不一致。");
  });
}

async function presentationRecipe(r: Runner, name: string) {
  const fileId = await r.step("create", "新建 PPTX 返回了有效文件 ID；该 ID 已保存。", async () => {
    const out = await r.call("create_empty_file", { name, file_extension: "pptx", on_name_conflict: "fail" }); pairCode(out);
    const id = identifier(payload(out).id); evidence(id, "新建演示未返回有效文件 ID。"); return id;
  });
  const slideId = await r.step("slide", "从插入响应取得实际幻灯片 ID。", async () => numericId(object(payload(
    await r.call("wpp.slide.items.insert", { file_id: fileId, index: 1, layout: 1 }),
  ).data).slide_id));
  const text = "云端演示验收 " + r.report.id;
  const shapeId = await r.step("textbox", "插入一个测试文本框并保存实际形状 ID。", async () => {
    const data = object(payload(await r.call("wpp.shape.items.textboxes", { file_id: fileId, slide_id: slideId,
      textboxes: [{ text, left: 36, top: 80, width: 640, height: 70 }] })).data);
    evidence(data.count === 1 && Array.isArray(data.shape_ids) && data.shape_ids.length === 1, "未取得唯一的新文本框 ID，不能猜测形状目标。");
    return numericId(data.shape_ids[0]);
  });
  await r.step("shapes", "在目标页的实际形状列表中找到本次新增文本框 ID。", async () => {
    const shapes = object(payload(await r.call("wpp.shape.items.list", { file_id: fileId, slide_id: slideId })).list_data).shapes;
    evidence(Array.isArray(shapes), "形状列表结构无法核实。");
    matches(shapes.some((item) => isRecord(item) && item.shape_id === shapeId), "回读形状列表没有找到本次新增文本框。");
  });
  await r.step("text", "从该形状逐字回读到本次唯一测试文本。", async () => {
    const data = payload(await r.call("wpp.shape.texts.text", { file_id: fileId, slide_id: slideId, shape_id: shapeId, verb: "query" }));
    evidence(typeof data.text === "string", "未取得文本框的真实正文。");
    matches(data.text === text, "文本框回读正文与写入内容不一致。");
  });
  await r.step("slides", "实际幻灯片列表包含本次新增页；未假定新文件最初没有页面。", async () => {
    const slides = object(payload(await r.call("wpp.slide.items.list", { file_id: fileId })).list_data).slides;
    evidence(Array.isArray(slides), "幻灯片列表结构无法核实。");
    matches(slides.some((item) => isRecord(item) && item.slide_id === slideId), "回读幻灯片列表没有找到本次新增页。");
  });
}

const FORM_QUESTIONS = [
  { question_id: "q_note", question: "验收备注", type: "input" },
  { question_id: "q_choice", question: "请选择验收项", type: "select",
    selects: [{ select_id: "o_doc", value: "文档" }, { select_id: "o_sheet", value: "表格" }] },
];
async function formRecipe(r: Runner, name: string) {
  const formId = await r.step("create", "已创建问卷草稿并保留其管理 ID；没有调用发布工具。", async () => {
    const data = payload(await r.call("form.lite.create_draft", { title: name, questions: FORM_QUESTIONS }));
    const id = identifier(data.form_id); evidence(id, "创建草稿没有返回有效问卷 ID。");
    matches(data.type === "Draft" && (!Object.hasOwn(data, "sid") || data.sid === ""), "创建响应未明确保持未发布草稿状态。"); return id;
  });
  const form = await r.step("draft", "回读问卷 ID、标题匹配，状态仍为 Draft，未出现发布标识。", async () => {
    const data = payload(await r.call("form.lite.get_form_info", { form_id: formId }));
    matches(data.form_id === formId && data.title === name, "回读问卷 ID 或标题与本次草稿不一致。");
    matches(data.type === "Draft" && (!Object.hasOwn(data, "sid") || data.sid === ""), "回读结果未保持明确的未发布草稿状态。"); return data;
  });
  await r.step("questions", "两道题的 ID、标题、类型和两个选项均与创建内容一致。", async () => {
    evidence(Array.isArray(form.questions), "未返回可核对的题目列表。");
    matches(form.questions.length === FORM_QUESTIONS.length, "回读题目数量与预期不一致。");
    for (const expected of FORM_QUESTIONS) {
      const actual = form.questions.find((item) => isRecord(item) && item.question_id === expected.question_id);
      matches(isRecord(actual) && actual.question === expected.question && actual.type === expected.type, "回读题目 ID、标题或类型与预期不一致。");
      if (expected.selects) {
        const selects = actual.selects; evidence(Array.isArray(selects), "未返回可核对的选项列表。");
        matches(selects.length === expected.selects.length && expected.selects.every((option) => selects.some((value) =>
          isRecord(value) && value.select_id === option.select_id && value.value === option.value)), "回读选项 ID、内容或数量与预期不一致。");
      }
    }
  });
}

/** Fixed, bounded recipes; the user cannot provide a target file, tool, or body. */
export async function runAcceptance(suite: unknown, requestId: unknown, actor: string, env: RuntimeEnv,
  dependencies: GatewayDependencies = {}): Promise<AcceptanceReport> {
  const selected = suiteValue(suite);
  const id = requireRequestId(requestId);
  const db = database(env);
  const previous = await getRow(db, actor, id);
  if (previous) {
    if (previous.suite !== selected) throw new WpsError("REQUEST_ID_REUSED", "此验收编号已经绑定另一类任务，不能复用。", 409);
    return viewRow(previous, env, dependencies.clock?.() ?? Date.now());
  }
  const name = NAMES[selected] + "-" + id;
  for (const [toolName, args] of recipeCalls(selected, name)) {
    const tool = findExecutableTool(toolName); validateCatalogArguments(tool, args);
    if (classifyOperation(tool, args) === "sensitive") throw new WpsError("ACCEPTANCE_UNSAFE_RECIPE", "验收模板包含敏感操作，已停止。", 500);
  }
  const caller = await connectionCaller(actor, env, dependencies);
  const clock = dependencies.clock ?? Date.now;
  const startedAt = clock();
  const report: StoredReport = { id, suite: selected, status: "running", startedAt, updatedAt: startedAt,
    checks: CHECKS[selected].map(([checkId, title]) => ({ id: checkId, title, status: "pending", detail: "尚未开始。" })), artifacts: [] };
  report.checks.push(selected === "form"
    ? { id: "publish", title: "发布与真实填写", status: "skipped", detail: "本套仅验收未发布草稿结构；发布、分享、真实提交与收集结果没有测试。" }
    : { id: "visual", title: "视觉排版与导出质量", status: "skipped", detail: "本套只核对基础内容和结构。没有渲染页面或下载导出文件，排版、字体、图片、溢出及打印质量尚未验收。" });
  const claim = await db.prepare("INSERT INTO wps_acceptance_runs " +
    "(user_id, request_id, suite, connection_id, status, started_at, updated_at, checks_json, artifacts_json, error_json) " +
    "VALUES (?, ?, ?, ?, 'running', ?, ?, ?, '[]', NULL) ON CONFLICT(user_id, request_id) DO NOTHING")
    .bind(actor, id, selected, caller.connectionId, startedAt, startedAt, JSON.stringify(report.checks)).run();
  if (claim.meta.changes !== 1) {
    const existing = await getRow(db, actor, id);
    if (!existing) throw new WpsError("ACCEPTANCE_STORE_UNAVAILABLE", "验收登记暂不可用，本次未发起 WPS 操作。", 503);
    if (existing.suite !== selected) throw new WpsError("REQUEST_ID_REUSED", "此验收编号已经绑定另一类任务，不能复用。", 409);
    return viewRow(existing, env, clock());
  }
  const runner = new Runner(report, actor, caller.connectionId, db, caller.callTool, clock);
  try {
    if (selected === "document") await documentRecipe(runner, name);
    else if (selected === "spreadsheet") await spreadsheetRecipe(runner, name);
    else if (selected === "presentation") await presentationRecipe(runner, name);
    else await formRecipe(runner, name);
    report.status = "passed";
  } catch (error) { runner.fail(error); }
  try { await runner.save(); }
  catch (error) { runner.fail(error); }
  return publicReport(report, caller.connectionId, await new WpsStore(db).getConnection(actor), clock());
}
