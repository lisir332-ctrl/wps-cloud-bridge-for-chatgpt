"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowDownToLine, ArrowUpRight, Check, ChevronDown, ChevronLeft, ChevronRight, CircleCheck, CloudUpload, FileText, LoaderCircle, Plus, Presentation, RefreshCw, Trash2, TriangleAlert } from "lucide-react";
import { ErrorCard } from "./ConnectionPanel.tsx";
import { apiRequest, ApiError, asApiError, isRecord, newRequestId, pretty } from "./wps-client.ts";
import { credentialWasInvalidated, safeArtifactUrl } from "./wps-ui-state.ts";
import { bulletLines, canContinuePresentationReadback, capturePresentationReadback, characterCount, checkPresentationDraft, checkedPresentationVerification, decodePresentationBase64, mergePresentationVerification, validPresentationId, type PresentationDraft, type PresentationInput, type PresentationReadbackTarget, type PresentationVerification } from "./presentation-client.ts";

type UploadResult = {
  status: "succeeded" | "pending" | "failed" | "uncertain" | "already_run" | "unknown_after_timeout";
  requestId: string; name?: string; slideCount?: number; fileId?: string; url?: string;
  verification?: PresentationVerification;
  notices?: string[]; error?: { code: string; message: string };
};
const INITIAL: PresentationDraft = {
  title: "项目进展汇报", theme: "forest",
  slides: [
    { id: "initial-1", title: "项目目标", points: "说明本次项目要解决的问题\n列出预期成果与验收标准\n明确当前阶段和时间安排" },
    { id: "initial-2", title: "当前进展", points: "已完成的工作与关键成果\n正在推进的事项和负责人\n需要协调的资源与风险" },
    { id: "initial-3", title: "下一步计划", points: "下一阶段的重点任务\n各项任务的完成时间\n需要确认的决定与支持" },
  ],
};
const MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const UPLOAD_LABELS = { succeeded: "上传请求已完成", pending: "等待官方任务完成", failed: "保存失败", uncertain: "保存结果需核对", already_run: "原请求已登记", unknown_after_timeout: "原请求结果未确认" };
const VERIFY_LABELS = { passed: "文字读回通过", pending: "文字读回待完成", failed: "文字读回未通过", not_run: "尚未验证文字读回" };

function checkedUpload(value: unknown): value is UploadResult {
  return isRecord(value) && Object.prototype.hasOwnProperty.call(UPLOAD_LABELS, String(value.status)) && typeof value.requestId === "string" &&
    ["name", "fileId", "url"].every((key) => value[key] === undefined || typeof value[key] === "string") &&
    (value.verification === undefined || checkedPresentationVerification(value.verification)) &&
    (value.error === undefined || (isRecord(value.error) && typeof value.error.code === "string" && typeof value.error.message === "string")) &&
    (value.notices === undefined || (Array.isArray(value.notices) && value.notices.every((notice) => typeof notice === "string")));
}

export default function PresentationComposer({ connected, connectionVersion, onCredentialInvalidated }: { connected: boolean; connectionVersion: number; onCredentialInvalidated: () => void }) {
  const [draft, setDraft] = useState<PresentationDraft>(INITIAL);
  const [previewPage, setPreviewPage] = useState(0);
  const [busy, setBusy] = useState<"download" | "save" | "verify" | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState("");
  const [uploadRequest, setUploadRequest] = useState<{ id: string; key: string } | null>(null);
  const [uploadResult, setUploadResult] = useState<UploadResult | null>(null);
  const [registration, setRegistration] = useState<UploadResult | null>(null);
  const [verificationError, setVerificationError] = useState<ApiError | null>(null);
  const [verificationNotice, setVerificationNotice] = useState("");
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const inFlight = useRef(false);
  const savedSpec = useRef<{ requestId: string; presentation: PresentationInput; connectionVersion: number } | null>(null);
  const readbackTarget = useRef<PresentationReadbackTarget | null>(null);
  const currentConnection = useRef({ connected, connectionVersion });
  const { presentation, errors } = checkPresentationDraft(draft);
  const key = presentation ? JSON.stringify(presentation) : "";
  const sameUpload = !!uploadRequest && uploadRequest.key === key;
  const preview = draft.slides[Math.min(previewPage, draft.slides.length - 1)];

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; controller.current?.abort(); }; }, []);
  useEffect(() => {
    currentConnection.current = { connected, connectionVersion };
    if (!connected) { readbackTarget.current = null; savedSpec.current = null; }
  }, [connected, connectionVersion]);

  function edit(next: PresentationDraft) {
    if (inFlight.current) return;
    setDraft(next); setError(null); setNotice(""); setRegistration(null);
  }

  function changeSlide(index: number, patch: Partial<PresentationDraft["slides"][number]>) {
    edit({ ...draft, slides: draft.slides.map((slide, position) => position === index ? { ...slide, ...patch } : slide) });
  }

  function addSlide() {
    if (inFlight.current || draft.slides.length >= 12) return;
    try {
      edit({ ...draft, slides: [...draft.slides, { id: newRequestId(), title: "", points: "" }] });
      setPreviewPage(draft.slides.length);
    } catch (cause) { setError(asApiError(cause)); }
  }

  async function download() {
    if (!presentation || inFlight.current) return;
    inFlight.current = true; setBusy("download"); setError(null); setNotice("");
    const abort = new AbortController(); controller.current = abort;
    try {
      const response = await apiRequest<{ name: string; contentBase64: string; slideCount: number; expectedTitles: string[] }>("/api/wps/presentation-file", { presentation }, { signal: abort.signal, timeoutMs: 60_000 });
      if (typeof response.name !== "string" || !response.name.endsWith(".pptx") || /[/\\]/.test(response.name) || response.slideCount !== presentation.slides.length)
        throw new ApiError("生成结果与本次页面数量不一致，未发起下载。", { code: "INVALID_PRESENTATION_FILE" });
      const bytes = decodePresentationBase64(response.contentBase64);
      if (!mounted.current) return;
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: MIME }));
      try { const link = document.createElement("a"); link.href = url; link.download = response.name; link.click(); }
      finally { setTimeout(() => URL.revokeObjectURL(url), 1_000); }
      setNotice(`已生成 ${response.slideCount} 页可编辑 PPTX，下载已发起。请打开文件确认排版。`);
    } catch (cause) {
      if (mounted.current) { setError(asApiError(cause)); if (credentialWasInvalidated(cause)) onCredentialInvalidated(); }
    } finally { inFlight.current = false; if (mounted.current) setBusy(null); }
  }

  async function save() {
    if (!presentation || !connected || inFlight.current) return;
    let id: string;
    try { id = sameUpload ? uploadRequest!.id : newRequestId(); }
    catch (cause) { setError(asApiError(cause)); return; }
    setUploadRequest({ id, key }); inFlight.current = true; setBusy("save"); setError(null); setNotice("");
    const original = { requestId: id, presentation: structuredClone(presentation), connectionVersion };
    savedSpec.current = original;
    const abort = new AbortController(); controller.current = abort;
    try {
      const response = await apiRequest<unknown>("/api/wps/presentation-create", { presentation, requestId: id }, { signal: abort.signal, timeoutMs: 180_000 });
      if (!checkedUpload(response) || response.requestId !== id) throw new ApiError("未收到完整保存结果。已保留原请求编号，请先核对登记状态。", { code: "INVALID_PRESENTATION_RESULT", retryable: true, requestId: id });
      if (!mounted.current) return;
      if (credentialWasInvalidated(response)) onCredentialInvalidated();
      if (["already_run", "unknown_after_timeout"].includes(response.status) && !response.fileId && !response.url) {
        setRegistration(response);
        setNotice("这里只更新原请求的登记状态；此前返回的文件和验证结果保持不变。");
      } else {
        const snapshot = savedSpec.current?.requestId === id ? savedSpec.current : original;
        readbackTarget.current = validPresentationId(response.fileId)
          ? capturePresentationReadback(snapshot.presentation, response.fileId, id, snapshot.connectionVersion) : null;
        setUploadResult(response); setRegistration(null); setVerificationError(null); setVerificationNotice("");
      }
    } catch (cause) {
      if (!mounted.current) return;
      const failure = asApiError(cause);
      if (!failure.requestId) failure.requestId = id;
      setError(failure);
      setNotice("保存请求未完整返回。再次点击将使用同一编号查询登记，不会自动换编号上传。");
      if (credentialWasInvalidated(failure)) onCredentialInvalidated();
    } finally { inFlight.current = false; if (mounted.current) setBusy(null); }
  }

  async function verifySavedPresentation() {
    const target = readbackTarget.current;
    if (inFlight.current || !canContinuePresentationReadback(target, uploadResult?.requestId, uploadResult?.fileId, connected, connectionVersion)) return;
    const taskId = uploadResult?.verification?.taskId;
    inFlight.current = true; setBusy("verify"); setVerificationError(null); setVerificationNotice("");
    const abort = new AbortController(); controller.current = abort;
    try {
      const response = await apiRequest<unknown>("/api/wps/presentation-verify", {
        presentation: target.presentation, fileId: target.fileId, ...(validPresentationId(taskId) ? { taskId } : {}),
      }, { signal: abort.signal, timeoutMs: 90_000 });
      if (!checkedPresentationVerification(response)) throw new ApiError("未收到有效的文字核对结果，原文件与任务编号已保留。", { code: "INVALID_PRESENTATION_VERIFICATION", retryable: true });
      if (!mounted.current) return;
      if (credentialWasInvalidated(response)) onCredentialInvalidated();
      const latest = currentConnection.current;
      if (!canContinuePresentationReadback(target, uploadResult?.requestId, uploadResult?.fileId, latest.connected, latest.connectionVersion)) {
        setVerificationNotice("连接已变化，本次核对结果未应用。原文件结果仍保留在此处。");
        return;
      }
      setUploadResult((previous) => {
        if (!previous || previous.requestId !== target.requestId || previous.fileId !== target.fileId) return previous;
        const verification = mergePresentationVerification(previous.verification, response);
        return { ...previous, verification, status: verification.status === "passed" ? "succeeded" : verification.status === "pending" ? "pending" : verification.status === "failed" ? "failed" : "uncertain",
          error: verification.error };
      });
      setVerificationNotice(response.status === "passed" ? "本次只读核对已通过，没有重新上传文件。" : response.status === "pending" ? "WPS 仍在处理，已保留最新任务编号。稍后可再次手动核对。" : "只读核对结果已更新，没有重新上传文件。");
    } catch (cause) {
      if (mounted.current) {
        setVerificationError(asApiError(cause));
        if (credentialWasInvalidated(cause)) onCredentialInvalidated();
      }
    } finally { inFlight.current = false; if (mounted.current) setBusy(null); }
  }

  const resultUrl = safeArtifactUrl(uploadResult?.url);
  const canReadBack = canContinuePresentationReadback(readbackTarget.current, uploadResult?.requestId, uploadResult?.fileId, connected, connectionVersion);

  return <section id="presentation" className="presentation-section workspace-section" aria-labelledby="presentation-heading">
    <div className="section-heading"><div><p className="section-kicker">MAKE AN EDITABLE PRESENTATION</p><h2 id="presentation-heading">把提纲，做成一份 PPT。</h2><p className="section-description">填写标题和每页要点，生成 16:9 的可编辑文字演示。可以直接下载，连接 WPS 后也能另存为新的云文件。</p></div><span className="presentation-format"><Presentation size={16} />16:9 · 可编辑 PPTX</span></div>
    <div className="presentation-layout">
      <div className="presentation-form">
        <div className="presentation-file-title"><label htmlFor="presentation-title">文件标题 <span>{characterCount(draft.title)} / 48</span></label><input id="presentation-title" value={draft.title} disabled={!!busy} onChange={(event) => edit({ ...draft, title: event.target.value })} aria-invalid={!!errors.title} aria-describedby={errors.title ? "presentation-title-error" : undefined} placeholder="例如：项目进展汇报" autoComplete="off" />{errors.title && <p className="field-error" id="presentation-title-error">{errors.title}</p>}</div>
        <fieldset className="presentation-themes" disabled={!!busy}><legend>选择主题</legend><button type="button" className={draft.theme === "forest" ? "selected" : ""} aria-pressed={draft.theme === "forest"} onClick={() => edit({ ...draft, theme: "forest" })}><span className="theme-swatch swatch-forest" />林绿{draft.theme === "forest" && <Check size={13} />}</button><button type="button" className={draft.theme === "ink" ? "selected" : ""} aria-pressed={draft.theme === "ink"} onClick={() => edit({ ...draft, theme: "ink" })}><span className="theme-swatch swatch-ink" />墨蓝{draft.theme === "ink" && <Check size={13} />}</button></fieldset>
        <div className="presentation-pages-heading"><strong>页面提纲</strong><span>{draft.slides.length} / 12 页</span></div>
        <p className="presentation-limits">每页标题最多 32 字；每页 1–5 条要点，每条最多 60 字。每行填写一条要点。</p>
        <div className="presentation-slide-editors">{draft.slides.map((slide, index) => <div className={`presentation-slide-editor ${previewPage === index ? "selected" : ""}`} key={slide.id}>
          <div className="slide-editor-heading"><button type="button" onClick={() => setPreviewPage(index)}>第 {index + 1} 页 · 预览<ArrowUpRight size={11} /></button><button type="button" className="slide-remove" aria-label={`移除第 ${index + 1} 页`} disabled={!!busy || draft.slides.length === 1} onClick={() => { edit({ ...draft, slides: draft.slides.filter((_, position) => position !== index) }); setPreviewPage(Math.max(0, Math.min(previewPage, draft.slides.length - 2))); }}><Trash2 size={13} />移除</button></div>
          <label htmlFor={`slide-title-${slide.id}`}>页面标题 <span>{characterCount(slide.title)} / 32</span></label><input id={`slide-title-${slide.id}`} value={slide.title} disabled={!!busy} onFocus={() => setPreviewPage(index)} onChange={(event) => changeSlide(index, { title: event.target.value })} aria-invalid={!!errors[`slides.${index}.title`]} placeholder="这一页要表达什么？" />{errors[`slides.${index}.title`] && <p className="field-error">{errors[`slides.${index}.title`]}</p>}
          <label htmlFor={`slide-points-${slide.id}`}>要点，一行一条 <span>{bulletLines(slide.points).length} / 5 条</span></label><textarea id={`slide-points-${slide.id}`} value={slide.points} rows={4} disabled={!!busy} onFocus={() => setPreviewPage(index)} onChange={(event) => changeSlide(index, { points: event.target.value })} aria-invalid={!!errors[`slides.${index}.points`]} placeholder="第一条要点&#10;第二条要点" spellCheck={false} />{errors[`slides.${index}.points`] && <p className="field-error">{errors[`slides.${index}.points`]}</p>}
        </div>)}</div>
        <button type="button" className="presentation-add-page" disabled={!!busy || draft.slides.length >= 12} onClick={addSlide}><Plus size={15} />添加一页</button>
        {errors.slides && <p className="field-error">{errors.slides}</p>}
      </div>
      <div className="presentation-preview-panel"><div className="presentation-preview-toolbar"><strong>内容预览</strong><span><button aria-label="预览上一页" disabled={previewPage === 0} onClick={() => setPreviewPage(Math.max(0, previewPage - 1))}><ChevronLeft size={16} /></button>{previewPage + 1} / {draft.slides.length}<button aria-label="预览下一页" disabled={previewPage >= draft.slides.length - 1} onClick={() => setPreviewPage(Math.min(draft.slides.length - 1, previewPage + 1))}><ChevronRight size={16} /></button></span></div>
        <div className={`presentation-slide-preview preview-${draft.theme}`} aria-label={`第 ${previewPage + 1} 页内容预览`}><h3>{preview?.title || "页面标题"}</h3><ul>{bulletLines(preview?.points || "").slice(0, 5).map((bullet, index) => <li key={index}>{bullet}</li>)}</ul><span>{String(previewPage + 1).padStart(2, "0")}</span></div>
        <p className="presentation-preview-note">这里预览内容和主题。最终排版以打开 PPTX 文件后的显示为准。</p>
        <div className="presentation-summary"><span><strong>{draft.slides.length}</strong> 页</span><span><strong>{draft.slides.reduce((count, slide) => count + bulletLines(slide.points).length, 0)}</strong> 条要点</span><span>固定 16:9<br />文字可编辑</span></div>
        <div className="presentation-actions"><button className="button button-secondary" onClick={() => void download()} disabled={!!busy || !presentation}>{busy === "download" ? <LoaderCircle size={16} className="spin" /> : <ArrowDownToLine size={16} />}{busy === "download" ? "正在生成文件…" : "下载 PPTX"}</button><button className="button button-primary" onClick={() => void save()} disabled={!!busy || !presentation || !connected}>{busy === "save" ? <LoaderCircle size={16} className="spin" /> : <CloudUpload size={16} />}{busy === "save" ? "正在等待保存结果…" : sameUpload ? "查看原请求登记状态" : "保存到 WPS"}</button></div>
        {!presentation && <p className="field-error">请修正表单中的提示后再生成。</p>}
        <p className="presentation-save-scope">保存到 WPS 将新建一份 PPTX，不覆盖已有文件。下载不要求连接 WPS。</p>
        {!connected && <a className="presentation-connect-link" href="#connection">先连接 WPS，再保存云文件<ArrowUpRight size={12} /></a>}
        {uploadRequest && <p className="presentation-request">保存请求编号 <code>{uploadRequest.id}</code>{!sameUpload && <span>提纲已变化；下一次保存将创建新的文件。</span>}</p>}
        {notice && <div className="feedback feedback-notice" role="status"><FileText size={15} /><p>{notice}</p></div>}
        {error && <ErrorCard error={error} />}
        {registration && <div className="presentation-registration"><strong>{UPLOAD_LABELS[registration.status]}</strong><p>原始文件结果保留在下方，登记响应不代表文字回读或视觉检查已完成。</p>{registration.notices?.map((text, index) => <p key={index}>{text}</p>)}</div>}
      </div>
    </div>
    {uploadResult && <div className="presentation-cloud-result"><div className="presentation-cloud-heading"><div><p className="section-kicker">LAST CLOUD SAVE</p><h3>{uploadResult.name || "最近一次保存请求"}</h3><span>{UPLOAD_LABELS[uploadResult.status]}</span></div>{resultUrl && <a className="button button-secondary" href={resultUrl} target="_blank" rel="noopener noreferrer">打开云端 PPT<ArrowUpRight size={14} /></a>}</div>
      <div className={`presentation-verification verification-${uploadResult.verification?.status || "not_run"}`}>{uploadResult.verification?.status === "passed" ? <CircleCheck size={18} /> : <TriangleAlert size={18} />}<div><strong>{VERIFY_LABELS[uploadResult.verification?.status || "not_run"]}</strong><p>{uploadResult.verification?.detail || "本次响应没有提供可核对的文字读回证据。"}</p></div></div>
      {uploadResult.verification?.status !== "passed" && <div className="presentation-readback-actions"><button className="button button-secondary" onClick={() => void verifySavedPresentation()} disabled={!!busy || !canReadBack}>{busy === "verify" ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />}{busy === "verify" ? "正在只读核对…" : "继续核对云端文字"}</button><p>{canReadBack ? "只读取这次保存的 PPT，使用保存时的原提纲；不会重新上传。" : !connected ? "请保持原 WPS 连接后再核对。" : "缺少本次原提纲、有效文件编号或同一连接，无法继续核对这份结果。"}</p></div>}
      {uploadResult.verification?.taskId && <p className="presentation-request">读取任务编号 <code>{uploadResult.verification.taskId}</code></p>}
      {uploadResult.verification?.error && <div className="acceptance-business-error"><strong>{uploadResult.verification.error.code}</strong><p>{uploadResult.verification.error.message}</p></div>}
      {verificationError && <ErrorCard error={verificationError} />}
      {verificationNotice && <p className="acceptance-notice" role="status">{verificationNotice}</p>}
      <p className="presentation-visual-limit">文字读回验证与视觉排版是两项检查。请打开成品，确认字体、换行和页面显示。</p>
      {uploadResult.error && (uploadResult.error.code !== uploadResult.verification?.error?.code || uploadResult.error.message !== uploadResult.verification?.error?.message) && <div className="acceptance-business-error"><strong>{uploadResult.error.code}</strong><p>{uploadResult.error.message}</p></div>}
      {uploadResult.notices?.map((text, index) => <p className="acceptance-notice" key={index}>{text}</p>)}
      <p className="presentation-request">请求编号 <code>{uploadResult.requestId}</code>{uploadResult.fileId && <span>文件 ID <code>{uploadResult.fileId}</code></span>}</p>
      <details className="acceptance-raw"><summary>查看原始保存结果<ChevronDown size={13} /></summary><pre>{pretty(uploadResult)}</pre></details>
    </div>}
  </section>;
}
