"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowDownToLine, ArrowRight, ArrowUpRight, Braces, Check, ChevronDown, ChevronLeft, ChevronRight, ClipboardCheck, Code2, Copy, FileQuestion, FileText, FolderSearch, Grid2X2, LoaderCircle, Play, Search, ShieldAlert, SlidersHorizontal, TriangleAlert } from "lucide-react";
import { ErrorCard } from "./ConnectionPanel.tsx";
import { apiRequest, ApiError, asApiError, formatDate, isRecord, newRequestId, OPERATION_LABELS, pretty, schemaExample, type Operation } from "./wps-client.ts";
import { credentialWasInvalidated, isExecutionReceipt } from "./wps-ui-state.ts";

type CatalogTool = {
  name: string; description: string; inputSchema: Record<string, unknown>; category: string;
  operation: Operation; capabilityNotes?: string[]; notes?: string[]; executionAllowed: boolean; referenceUrl?: string;
};
type CatalogResponse = {
  items: CatalogTool[]; total: number; offset: number; limit: number; nextOffset: number | null;
  summary?: { total: number; capturedAt?: string; categories?: { category: string; label: string; count: number }[] };
};
type Preview = {
  valid: boolean; summary: { steps: number; reads: number; writes: number };
  steps: { id: string; tool: string; operation: Operation; references: { step: string; pointer: string }[]; status: "ready" | "deferred" }[];
  errors: { step?: string; code: string; message: string }[]; notices: string[];
};
type SensitiveReview = { tool: string; arguments: Record<string, unknown>; operation: "sensitive"; reviewToken: string; requestId: string; expiresAt: number; notices: string[] };
type Plan = { version: 1; on_error: "stop"; steps: { id: string; tool: string; arguments: Record<string, unknown> }[] };

const CATEGORIES = [
  ["", "全部功能"], ["drive", "云文件"], ["wps", "文字文档"], ["sheet", "表格"], ["wpp", "演示"],
  ["pdf", "PDF"], ["dbsheet", "多维表"], ["form", "问卷"], ["kwiki", "知识库"], ["otl", "智能文档"], ["aippt", "AI 演示"],
] as const;

function plan(tool: string, args: Record<string, unknown>, id = "step_1"): Plan {
  return { version: 1, on_error: "stop", steps: [{ id, tool, arguments: args }] };
}

const TEMPLATES: { key: string; title: string; description: string; operation: "read" | "write"; icon: typeof FileText; plan: Plan }[] = [
  { key: "files", title: "查找云文件", description: "按名称查找文件，获取真实 ID。", operation: "read", icon: FolderSearch,
    plan: plan("search_files", { keyword: "会议", type: "file_name", page_size: 20 }, "find_files") },
  { key: "document", title: "新建文字文档", description: "把 Markdown 保存为新的 Word 文档。", operation: "write", icon: FileText,
    plan: plan("create_file_with_content", { name: "我的工作计划", file_extension: "docx", content: "# 我的工作计划\n\n## 本周目标\n\n- 请填写你的目标\n" }, "create_document") },
  { key: "spreadsheet", title: "新建数据表格", description: "从二维数据创建一个 xlsx 文件。", operation: "write", icon: Grid2X2,
    plan: plan("create_file_with_content", { name: "任务跟进", file_extension: "xlsx", sheet_name: "任务", rangeData: [{ row_from: 0, row_to: 2, col_from: 0, col_to: 2, formula: [["任务", "负责人", "状态"], ["请填写任务", "请填写姓名", "待开始"], ["另一项任务", "请填写姓名", "进行中"]] }] }, "create_spreadsheet") },
  { key: "questionnaire", title: "问卷草稿", description: "创建选择题与填空题草稿，不发布。", operation: "write", icon: FileQuestion,
    plan: plan("form.lite.create_draft", { title: "课程反馈", questions: [{ question_id: "q_topic", question: "你最希望学习的主题？", type: "select", selects: [{ select_id: "s_doc", value: "文档自动化" }, { select_id: "s_sheet", value: "表格分析" }] }, { question_id: "q_note", question: "其他建议", type: "input" }] }, "draft") },
  { key: "replace", title: "精确替换段落", description: "填写真实文件 ID 与刚读取的完整原文。", operation: "write", icon: FileText,
    plan: plan("wps.texts.replace", { file_id: "请填写刚读取的真实文件 ID", scope: "paragraphs", items: [{ src: "请粘贴文档中的完整原段落", dst: "请填写替换后的完整段落" }], skip_heading: true, skip_on_multi_match: true }, "replace_paragraph") },
];

function OperationBadge({ operation }: { operation: Operation }) {
  return <span className={`operation-badge operation-${operation}`}>{OPERATION_LABELS[operation] || "待分类"}</span>;
}

function parseObject(text: string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new ApiError("JSON 格式不正确，请检查双引号、逗号和括号。", { code: "INVALID_JSON", stage: "workbench" }); }
  if (!isRecord(value)) throw new ApiError("请输入一个 JSON 对象，不能是数组或普通文字。", { code: "INVALID_JSON_OBJECT", stage: "workbench" });
  return value;
}

function publicReview(review: SensitiveReview) {
  return { tool: review.tool, arguments: review.arguments, operation: review.operation, expiresAt: review.expiresAt, notices: review.notices };
}

export default function WpsWorkspace({ connected, onCredentialInvalidated }: { connected: boolean; onCredentialInvalidated: () => void }) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [offset, setOffset] = useState(0);
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null);
  const [catalogTotal, setCatalogTotal] = useState<number | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState<ApiError | null>(null);
  const [selected, setSelected] = useState<CatalogTool | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [mode, setMode] = useState<"plan" | "tool">("plan");
  const [activeTool, setActiveTool] = useState<CatalogTool | null>(null);
  const [source, setSource] = useState(pretty(TEMPLATES[0].plan));
  const [preview, setPreview] = useState<Preview | null>(null);
  const [sensitiveReview, setSensitiveReview] = useState<SensitiveReview | null>(null);
  const [confirmedTool, setConfirmedTool] = useState("");
  const [previewSource, setPreviewSource] = useState<string | null>(null);
  const [executionId, setExecutionId] = useState<string | null>(null);
  const [result, setResult] = useState<unknown>(null);
  const [resultRequestId, setResultRequestId] = useState<string | null>(null);
  const [resultTool, setResultTool] = useState("");
  const [executionRecord, setExecutionRecord] = useState<unknown>(null);
  const [submittedId, setSubmittedId] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<"preview" | "run" | null>(null);
  const [copied, setCopied] = useState<"source" | "result" | null>(null);
  const detailController = useRef<AbortController | null>(null);
  const requestController = useRef<AbortController | null>(null);
  const revision = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    setCatalogLoading(true); setCatalogError(null);
    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ query, category, offset: String(offset), limit: "24" });
        const data = await apiRequest<CatalogResponse>(`/api/wps/catalog?${params}`, undefined, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setCatalog(data);
        if (data.summary?.total !== undefined) setCatalogTotal(data.summary.total);
        else if (!query && !category) setCatalogTotal(data.total);
      } catch (cause) { if (!controller.signal.aborted) { setCatalogError(asApiError(cause)); if (credentialWasInvalidated(cause)) onCredentialInvalidated(); } }
      finally { if (!controller.signal.aborted) setCatalogLoading(false); }
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, category, offset, onCredentialInvalidated]);

  useEffect(() => () => { detailController.current?.abort(); requestController.current?.abort(); }, []);

  async function selectTool(tool: CatalogTool) {
    detailController.current?.abort();
    const controller = new AbortController(); detailController.current = controller;
    setSelected(tool); setDetailLoading(true);
    try {
      const response = await apiRequest<CatalogTool | { tool: CatalogTool }>(`/api/wps/detail?name=${encodeURIComponent(tool.name)}`, undefined, { signal: controller.signal });
      if (controller.signal.aborted) return;
      setSelected("tool" in response ? response.tool : response);
    } catch (cause) { if (!controller.signal.aborted) { setCatalogError(asApiError(cause)); if (credentialWasInvalidated(cause)) onCredentialInvalidated(); } }
    finally { if (!controller.signal.aborted) setDetailLoading(false); }
  }

  function invalidate() {
    revision.current++;
    setPreview(null); setSensitiveReview(null); setConfirmedTool(""); setPreviewSource(null); setExecutionId(null); setError(null); setNotice(""); setCopied(null); setExecutionRecord(null);
  }

  function loadTemplate(template: typeof TEMPLATES[number]) {
    if (busy) return;
    invalidate(); setMode("plan"); setActiveTool(null); setSource(pretty(template.plan));
    setNotice(`已填入「${template.title}」示例，尚未执行。请修改内容并预检。`);
  }

  function useSelectedTool() {
    if (!selected || busy) return;
    invalidate(); setMode("tool"); setActiveTool(selected); setSource(pretty(schemaExample(selected.inputSchema)));
    setNotice("已填入参数示例。请将占位值替换为真实文件信息，预检后再执行。");
    document.getElementById("workbench")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function preflight() {
    setError(null); setNotice(""); setBusy("preview"); setPreview(null); setSensitiveReview(null); setConfirmedTool(""); setPreviewSource(null);
    const currentRevision = revision.current;
    const controller = new AbortController(); requestController.current = controller;
    try {
      const value = parseObject(source);
      const candidate = mode === "tool" && activeTool ? plan(activeTool.name, value) : value;
      const next = await apiRequest<Preview>("/api/wps/preview", { plan: candidate }, { signal: controller.signal });
      if (currentRevision !== revision.current) return;
      // Risk is parameter dependent. The backend is the authority, including
      // mixed read/write tools, paid conversion, deletion and empty replacement.
      if (mode === "tool" && activeTool && next.errors.length === 1 && next.errors[0].code === "SENSITIVE_WORKFLOW_FORBIDDEN") {
        const review = await apiRequest<SensitiveReview>("/api/wps/call-preview", { tool: activeTool.name, arguments: value }, { signal: controller.signal });
        if (currentRevision !== revision.current) return;
        setSensitiveReview(review); setExecutionId(review.requestId); setPreviewSource(source);
      } else {
        setPreview(next); setPreviewSource(source);
      }
    } catch (cause) { if (!controller.signal.aborted) { setError(asApiError(cause)); if (credentialWasInvalidated(cause)) onCredentialInvalidated(); } }
    finally { setBusy(null); }
  }

  async function run() {
    if (busy || previewSource !== source || (!preview?.valid && !sensitiveReview)) return;
    if (sensitiveReview && (confirmedTool !== sensitiveReview.tool || sensitiveReview.expiresAt <= Date.now())) return;
    let id: string;
    try { id = executionId || newRequestId(); }
    catch (cause) { setError(asApiError(cause)); return; }
    setError(null); setNotice(""); setBusy("run");
    const repeated = submittedId === id;
    setExecutionId(id); setSubmittedId(id);
    const controller = new AbortController(); requestController.current = controller;
    try {
      const value = parseObject(source);
      const response = mode === "tool" && activeTool
        ? await apiRequest<unknown>("/api/wps/call", {
          tool: activeTool.name, arguments: value, mode: sensitiveReview ? "sensitive" : preview?.steps[0]?.operation, requestId: id,
          ...(sensitiveReview ? { reviewToken: sensitiveReview.reviewToken, confirmedTool } : {}),
        }, { signal: controller.signal, timeoutMs: 180_000 })
        : await apiRequest<unknown>("/api/wps/run", { plan: value, requestId: id }, { signal: controller.signal, timeoutMs: 180_000 });
      if (credentialWasInvalidated(response)) onCredentialInvalidated();
      if (isExecutionReceipt(response)) {
        setExecutionRecord(response);
        setNotice("已查询执行登记状态。此响应不含原始输出；下方保留此前收到的步骤结果。");
      } else {
        setResult(response); setResultRequestId(id); setResultTool(mode === "tool" ? activeTool?.name || "" : "工作流"); setExecutionRecord(null);
        setNotice("请求已返回。请检查每一步的 output 状态与任务编号；有写入时，再用只读工具核对内容。");
      }
    } catch (cause) {
      const failure = asApiError(cause); setError(failure);
      if (credentialWasInvalidated(failure)) onCredentialInvalidated();
      const failed = { status: failure.retryable ? "unknown_after_timeout" : "failed", requestId: id, error: { code: failure.code, message: failure.message }, ...(failure.partialResult !== undefined ? { partialResult: failure.partialResult } : {}), notices: failure.retryable ? ["响应未能完整返回，操作可能已执行。已保留原请求编号；请先只读核对，不要改用新编号重复写入。"] : [] };
      if (repeated && result !== null) setExecutionRecord(failed);
      else { setResult(failed); setResultRequestId(id); setResultTool(mode === "tool" ? activeTool?.name || "" : "工作流"); }
    } finally { setBusy(null); }
  }

  async function copy(which: "source" | "result") {
    try { await navigator.clipboard.writeText(which === "source" ? source : pretty(result)); setCopied(which); }
    catch { setNotice("复制未成功，可以直接选择文本复制。"); }
  }

  function downloadResult() {
    const blob = new Blob([pretty(result)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a"); link.href = url; link.download = `wps-result-${resultRequestId || "latest"}.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }

  const notes = selected?.capabilityNotes || selected?.notes || [];
  const ready = previewSource === source && (preview?.valid || !!sensitiveReview);
  const hasWrites = !!sensitiveReview || (preview?.summary.writes || 0) > 0;
  const resultStatus = isRecord(result) && typeof result.status === "string" ? result.status : null;
  const uncertain = resultStatus && ["pending", "partial", "uncertain", "unknown_after_timeout", "already_run"].includes(resultStatus);
  const repeatRead = mode === "tool" && preview?.steps[0]?.operation === "read";
  const checkingRecord = !!executionId && submittedId === executionId && !repeatRead;

  return <>
    <section className="catalog-section workspace-section" id="catalog" aria-labelledby="catalog-heading">
      <div className="section-heading"><div><p className="section-kicker">EXPLORE YOUR CLOUD TOOLS</p><h2 id="catalog-heading">完整工具目录，按需要选择。</h2><p className="section-description">查看官方工具的参数与能力边界。目录收录不代表每项功能都已通过你的账号实测。</p></div><span className="catalog-count"><Braces size={16} /><strong>{catalogTotal ?? "—"}</strong> 项工具</span></div>
      <div className="catalog-controls"><label className="catalog-search"><Search size={17} /><input value={query} onChange={(event) => { setQuery(event.target.value); setOffset(0); }} placeholder="搜索工具名、描述或功能，例如：问卷、段落、合并" aria-label="搜索 WPS 工具" /></label><span className="catalog-filter-label"><SlidersHorizontal size={14} />按功能筛选</span></div>
      <div className="category-tabs" aria-label="工具分类">{CATEGORIES.map(([key, label]) => <button key={key} className={category === key ? "active" : ""} aria-pressed={category === key} onClick={() => { setCategory(key); setOffset(0); }}>{label}</button>)}</div>
      {catalogError && <ErrorCard error={catalogError} />}
      <div className="catalog-layout">
        <div className="catalog-list-panel">
          <div className="panel-topline"><span>{catalogLoading ? "正在查找…" : `${catalog?.total ?? 0} 项匹配`}</span><span className="operation-legend"><i className="legend-read" />读取<i className="legend-write" />写入<i className="legend-sensitive" />敏感</span></div>
          <div className={`catalog-list ${catalogLoading ? "catalog-list-loading" : ""}`} aria-busy={catalogLoading}>
            {catalogLoading && !catalog && <div className="empty-state"><LoaderCircle className="spin" size={25} /><p>正在加载官方工具目录…</p></div>}
            {!catalogLoading && catalog?.items.length === 0 && <div className="empty-state"><Search size={26} /><strong>没有找到匹配的工具</strong><p>换个关键词，或选择「全部功能」。</p></div>}
            {catalog?.items.map((tool) => <button key={tool.name} className={`catalog-tool ${selected?.name === tool.name ? "selected" : ""}`} aria-pressed={selected?.name === tool.name} onClick={() => void selectTool(tool)}><div><code>{tool.name}</code><OperationBadge operation={tool.operation} /></div><p>{tool.description || "查看参数和能力说明"}</p>{!tool.executionAllowed && <small>仅展示 · 当前不开放执行</small>}</button>)}
          </div>
          <div className="catalog-pagination"><span>{catalog?.total ? `${offset + 1}–${Math.min(offset + (catalog?.items.length || 0), catalog.total)} / ${catalog.total}` : "0 项"}</span><div><button aria-label="上一页工具" disabled={offset === 0 || catalogLoading} onClick={() => setOffset(Math.max(0, offset - 24))}><ChevronLeft size={16} /></button><button aria-label="下一页工具" disabled={catalog?.nextOffset == null || catalogLoading} onClick={() => setOffset(catalog?.nextOffset ?? offset)}><ChevronRight size={16} /></button></div></div>
        </div>
        <aside className="tool-detail-panel" aria-label="工具详情">
          {!selected ? <div className="tool-detail-placeholder"><Braces size={36} strokeWidth={1.3} /><h3>先认识工具，再开始操作。</h3><p>在左侧选择一项功能，查看原始参数、风险类型和 JSON 示例。</p><div><OperationBadge operation="read" /><OperationBadge operation="write" /><OperationBadge operation="sensitive" /></div></div> : <>
            <div className="panel-topline"><span>工具详情</span>{detailLoading ? <LoaderCircle size={15} className="spin" /> : <OperationBadge operation={selected.operation} />}</div>
            <h3 className="tool-name">{selected.name}</h3><p className="tool-description">{selected.description}</p>
            {selected.referenceUrl && <a className="tool-reference-link" href={selected.referenceUrl} target="_blank" rel="noopener noreferrer">查看官方能力说明<ArrowUpRight size={13} /></a>}
            {notes.length > 0 && <div className="capability-notes"><strong>能力边界</strong><ul>{notes.map((note, i) => <li key={i}>{note}</li>)}</ul></div>}
            {!selected.executionAllowed && <div className="inline-warning"><ShieldAlert size={15} /><span>该工具当前仅供查看，连接器不会执行它。</span></div>}
            <details className="schema-details"><summary>原始参数结构 <ChevronDown size={14} /></summary><pre>{pretty(selected.inputSchema)}</pre></details>
            <details className="schema-details" open><summary>JSON 参数示例 <ChevronDown size={14} /></summary><pre>{pretty(schemaExample(selected.inputSchema))}</pre><p>这是结构示例，ID 和选区需根据真实文件填写；数字占位值不能当作实际工作表 ID。</p></details>
            <button className="button button-primary" onClick={useSelectedTool} disabled={busy !== null || detailLoading || !selected.executionAllowed}><Code2 size={15} />填入工作台<ArrowRight size={15} /></button>
          </>}
        </aside>
      </div>
    </section>

    <section className="workbench-section workspace-section" id="workbench" aria-labelledby="workbench-heading">
      <div className="section-heading"><div><p className="section-kicker">READ THE PLAN. THEN RUN IT.</p><h2 id="workbench-heading">用一份 JSON，组织你的操作。</h2><p className="section-description">先填写与预检，再明确执行。这里只接收声明式 JSON 计划，不运行任意 JavaScript。</p></div><span className={`workbench-connection ${connected ? "connected" : ""}`}><span />{connected ? "WPS 已授权" : "执行前请先连接 WPS"}</span></div>
      <div className="template-grid" aria-label="工作流模板">{TEMPLATES.map((template) => { const Icon = template.icon; return <button key={template.key} className="template-card" onClick={() => loadTemplate(template)} disabled={!!busy}><div><Icon size={18} /><OperationBadge operation={template.operation} /></div><strong>{template.title}</strong><p>{template.description}</p><span>填入示例 <ArrowRight size={12} /></span></button>; })}</div>
      <p className="template-note">模板只填入编辑器，不会自动执行。问卷模板只创建草稿；公开发布需单独审阅敏感操作。</p>
      <div className="workbench-layout">
        <div className="editor-panel">
          <div className="editor-toolbar"><div className="editor-mode"><button className={mode === "plan" ? "active" : ""} disabled={!!busy} onClick={() => { if (mode !== "plan") { invalidate(); setMode("plan"); setSource(pretty(TEMPLATES[0].plan)); } }}>工作流计划</button><button className={mode === "tool" ? "active" : ""} disabled={!activeTool || !!busy} onClick={() => { if (mode !== "tool" && activeTool) { invalidate(); setMode("tool"); setSource(pretty(schemaExample(activeTool.inputSchema))); } }}>单项工具</button></div><button className="text-button" onClick={() => void copy("source")}><Copy size={13} />{copied === "source" ? "已复制" : "复制 JSON"}</button></div>
          <div className="editor-filename"><Code2 size={14} /><span>{mode === "tool" ? activeTool?.name : "workflow.json"}</span>{mode === "tool" && activeTool && <OperationBadge operation={activeTool.operation} />}</div>
          <textarea className="json-editor" aria-label={mode === "tool" ? "工具参数 JSON" : "工作流计划 JSON"} value={source} onChange={(event) => { invalidate(); setSource(event.target.value); }} spellCheck={false} autoComplete="off" disabled={!!busy} />
          <div className="editor-bottom"><span>{source.length.toLocaleString()} 个字符 · 编辑后需重新预检</span><button className="text-button" disabled={!!busy} onClick={() => { try { const formatted = pretty(parseObject(source)); if (formatted !== source) { invalidate(); setSource(formatted); } } catch (cause) { setError(asApiError(cause)); } }}>格式化</button></div>
        </div>
        <div className="review-panel">
          <div className="panel-topline"><span><ClipboardCheck size={15} /> 操作预检</span><span className={`review-status ${ready ? "ready" : ""}`}>{busy === "preview" ? "检查中" : ready ? "可审阅" : "待预检"}</span></div>
          {!preview && !sensitiveReview && <div className="review-placeholder"><ClipboardCheck size={30} strokeWidth={1.3} /><h3>先确认将发生什么。</h3><p>预检会检查工具、参数和步骤引用。不会读取文档或执行写入，也无法替代真实文件权限验证。</p></div>}
          {preview && <>
            <div className="review-stats"><div><strong>{preview.summary.steps}</strong><span>步骤</span></div><div><strong>{preview.summary.reads}</strong><span>读取</span></div><div><strong>{preview.summary.writes}</strong><span>写入</span></div></div>
            <ol className="review-steps">{preview.steps.map((step) => <li key={step.id}><span className="review-step-dot">{step.operation === "read" ? <Search size={12} /> : <ArrowRight size={12} />}</span><div><strong>{step.id}</strong><code>{step.tool}</code>{step.references?.length > 0 && <small>运行时引用 {step.references.map((reference) => reference.step).join("、")} 的结果</small>}{step.status === "deferred" && <small>参数依赖前置结果，执行前会再次验证。</small>}</div><OperationBadge operation={step.operation} /></li>)}</ol>
            {preview.errors.length > 0 && <div className="preview-errors" role="alert"><strong>请先修正以下问题</strong>{preview.errors.map((issue, i) => <p key={i}>{issue.step ? `${issue.step}：` : ""}{issue.message} <code>{issue.code}</code></p>)}</div>}
            {preview.notices?.map((text, i) => <p className="review-notice" key={i}>{text}</p>)}
          </>}
          {sensitiveReview && <div className="sensitive-review"><div className="inline-warning"><ShieldAlert size={18} /><span>该操作可能删除、公开发布或改变权限。请核对下方完整工具与参数。</span></div><pre>{pretty(publicReview(sensitiveReview))}</pre><label htmlFor="confirm-sensitive-tool">输入完整工具名以确认</label><input id="confirm-sensitive-tool" value={confirmedTool} onChange={(event) => setConfirmedTool(event.target.value)} placeholder={sensitiveReview.tool} autoComplete="off" spellCheck={false} disabled={!!busy} /><small>审阅有效至 {formatDate(sensitiveReview.expiresAt)}。参数改变后必须重新预检。</small></div>}
          <div className="review-actions"><button className="button button-secondary" disabled={!!busy || (mode === "tool" && !activeTool?.executionAllowed)} onClick={() => void preflight()}>{busy === "preview" ? <LoaderCircle size={15} className="spin" /> : <ClipboardCheck size={15} />}预检这份 {mode === "tool" ? "参数" : "计划"}</button><button className={`button ${sensitiveReview ? "button-danger" : "button-primary"}`} disabled={!connected || !!busy || !ready || (!!sensitiveReview && (confirmedTool !== sensitiveReview.tool || sensitiveReview.expiresAt <= Date.now()))} onClick={() => void run()}>{busy === "run" ? <LoaderCircle size={15} className="spin" /> : <Play size={14} />}{busy === "run" ? "正在等待响应，请勿重复提交…" : checkingRecord ? "查看执行登记状态" : executionId && submittedId === executionId && repeatRead ? "重新运行只读查询" : sensitiveReview ? "确认并执行敏感操作" : hasWrites ? "确认写入并运行" : "运行只读计划"}</button></div>
          {executionId && <p className="request-id-note">执行编号 <code>{executionId}</code></p>}
          <p className="execution-note">写入不会自动重试。返回不确定状态时，先只读核对文档，再决定下一步。</p>
        </div>
      </div>
      {error && <ErrorCard error={error} />}
      {notice && !error && <div className="feedback feedback-notice" role="status"><Check size={15} /><p>{notice}</p></div>}
      {executionRecord !== null && <details className="execution-record" open><summary>执行登记状态 · 原始结果保持不变<ChevronDown size={14} /></summary><p>登记状态用于确认同一请求是否已提交，不包含历史文档正文，也不代表异步任务已完成。</p><pre>{pretty(executionRecord)}</pre></details>}
      {result !== null && <section className="execution-result" aria-labelledby="result-heading"><div className="result-heading"><div><p className="section-kicker">LAST EXECUTION</p><h3 id="result-heading">最近一次步骤结果{resultStatus && <span className={`result-status ${uncertain ? "uncertain" : resultStatus === "failed" ? "failed" : ""}`}>{({ succeeded: "请求已返回", pending: "等待官方任务完成", partial: "部分请求已返回", failed: "失败", uncertain: "结果不确定", already_run: "已提交过", unknown_after_timeout: "需核对执行状态" } as Record<string, string>)[resultStatus] || resultStatus}</span>}</h3><p>{resultTool} · <code>{resultRequestId}</code></p></div><div><button className="copy-button" onClick={() => void copy("result")}><Copy size={13} />{copied === "result" ? "已复制" : "复制结果"}</button><button className="copy-button" onClick={downloadResult}><ArrowDownToLine size={13} />下载 JSON</button></div></div><p className="result-state-note">异步任务请检查实际 output 中的状态与任务编号；请求返回不等于文件已生成完成。</p>{uncertain && <div className="inline-warning"><TriangleAlert size={16} /><span>请检查各步骤状态与实际文档。保留原请求编号，不要直接重复创建或写入。</span></div>}<pre>{pretty(result)}</pre></section>}
      <details className="workflow-help"><summary>如何引用上一步的结果？ <ChevronDown size={14} /></summary><p>在参数中使用 <code>{'{"$ref":{"step":"前一步的 id","pointer":"/data/file_id"}}'}</code>。路径基于该步骤的实际输出；先看真实结果，避免猜测。普通工作流遇到失败会停止，已完成的步骤不会自动撤销，敏感操作需要单独审阅。</p><p>本页显示的执行结果只保留在当前页面内存中。刷新后不恢复文档正文；可以在刷新前下载 JSON 备查。</p></details>
    </section>
  </>;
}
