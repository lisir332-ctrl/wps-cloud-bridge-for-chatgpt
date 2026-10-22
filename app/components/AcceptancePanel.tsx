"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDownToLine, ArrowUpRight, Check, ChevronDown, Circle, CircleCheck, CircleX, ClipboardCheck, Copy, FileQuestion, FileText, Grid2X2, LoaderCircle, Play, Presentation, RefreshCw, TriangleAlert } from "lucide-react";
import { ErrorCard } from "./ConnectionPanel.tsx";
import { apiRequest, ApiError, asApiError, asMilliseconds, formatDate, newRequestId, pretty } from "./wps-client.ts";
import { ACCEPTANCE_SUITES, acceptanceDiagnostic, acceptancePresentation, credentialWasInvalidated, isAcceptanceReport, mergeAcceptanceReports, safeArtifactUrl, type AcceptanceReport, type AcceptanceReports, type AcceptanceSuite } from "./wps-ui-state.ts";

const SUITES = {
  document: { title: "文档读写", item: "测试文档", icon: FileText, description: "新建 Word 文档，检查写入的正文与实际读回内容。", checks: ["创建专用测试文档", "写入并读回测试正文", "核对基础内容"] },
  spreadsheet: { title: "表格数据", item: "测试表格", icon: Grid2X2, description: "新建表格，检查测试单元格与实际读取的数据。", checks: ["创建专用测试表格", "写入并读取测试数据", "核对单元格内容"] },
  presentation: { title: "PPT 制作", item: "测试 PPT", icon: Presentation, description: "新建演示文稿，检查页面内容与基础结构。", checks: ["创建专用测试 PPT", "写入并读取页面内容", "核对页数与基础结构"] },
  form: { title: "问卷草稿", item: "问卷草稿", icon: FileQuestion, description: "创建专用测试草稿，核对题目；不自动发布。", checks: ["创建专用问卷草稿", "读取草稿与题目", "核对内容与草稿状态"] },
} as const;

function CheckStatus({ status, running = false }: { status: AcceptanceReport["checks"][number]["status"]; running?: boolean }) {
  if (status === "passed") return <CircleCheck size={16} />;
  if (status === "failed") return <CircleX size={16} />;
  if (status === "uncertain") return <TriangleAlert size={16} />;
  if (status === "pending" && running) return <LoaderCircle size={16} className="spin" />;
  return <Circle size={16} />;
}

const CHECK_LABELS = { pending: "待完成", passed: "通过", failed: "失败", skipped: "未运行 / 未检查", uncertain: "待完成 · 需核对" };

export default function AcceptancePanel({ connected, refreshNonce, onCredentialInvalidated }: {
  connected: boolean; refreshNonce: number; onCredentialInvalidated: () => void;
}) {
  const [reports, setReports] = useState<AcceptanceReports>({});
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [suiteErrors, setSuiteErrors] = useState<Partial<Record<AcceptanceSuite, ApiError>>>({});
  const [runningSuite, setRunningSuite] = useState<AcceptanceSuite | null>(null);
  const [recovery, setRecovery] = useState<{ suite: AcceptanceSuite; id: string; until: number } | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const mounted = useRef(true);
  const readController = useRef<AbortController | null>(null);
  const writeController = useRef<AbortController | null>(null);
  const activeRun = useRef<string | null>(null);
  const lastRunIds = useRef<Partial<Record<AcceptanceSuite, string>>>({});
  const connectionEpoch = useRef(0);

  const refreshReports = useCallback(async () => {
    readController.current?.abort();
    const controller = new AbortController(); readController.current = controller;
    setLoading(true);
    try {
      const response = await apiRequest<{ reports: unknown[] }>("/api/wps/acceptance", undefined, { signal: controller.signal });
      if (!Array.isArray(response.reports) || !response.reports.every(isAcceptanceReport))
        throw new ApiError("验收报告格式不完整，请刷新报告后核对。", { code: "INVALID_ACCEPTANCE_REPORT" });
      if (!mounted.current || controller.signal.aborted) return;
      setReports((current) => mergeAcceptanceReports(current, response.reports as AcceptanceReport[]));
      setLoaded(true); setLoadError(null);
      setSuiteErrors((current) => {
        const next = { ...current };
        for (const report of response.reports as AcceptanceReport[]) {
          if (lastRunIds.current[report.suite] === report.id && report.status !== "running") delete next[report.suite];
        }
        return next;
      });
      setRecovery((current) => current && response.reports.some((report) => isAcceptanceReport(report) && report.id === current.id && report.status !== "running") ? null : current);
    } catch (cause) {
      if (mounted.current && !controller.signal.aborted) {
        setLoadError(asApiError(cause));
        if (credentialWasInvalidated(cause)) onCredentialInvalidated();
      }
    } finally { if (mounted.current && !controller.signal.aborted) setLoading(false); }
  }, [onCredentialInvalidated]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; readController.current?.abort(); writeController.current?.abort(); };
  }, []);

  useEffect(() => {
    // A previous account's success is never displayed as this connection's pass.
    connectionEpoch.current++;
    setReports((current) => Object.fromEntries(Object.entries(current).map(([suite, report]) => [suite, { ...report, connectionCurrent: false }])));
    void refreshReports();
  }, [connected, refreshNonce, refreshReports]);

  useEffect(() => {
    const recentlyRunning = Object.values(reports).some((report) => report?.connectionCurrent === true && report.status === "running" &&
      asMilliseconds(report.startedAt) + 240_000 > Date.now());
    const recovering = !!recovery && recovery.until > Date.now();
    // GET only reads persisted snapshots. "pending" has stopped and needs review;
    // it does not mean a background job will eventually pass by itself.
    if (!connected || (!runningSuite && !recentlyRunning && !recovering)) return;
    const timer = setTimeout(() => void refreshReports(), 5_000);
    return () => clearTimeout(timer);
  }, [connected, reports, runningSuite, recovery, refreshReports]);

  async function start(suite: AcceptanceSuite) {
    if (!connected || activeRun.current) return;
    const current = reports[suite];
    if (current?.connectionCurrent === true && current.status === "running") return;
    let id: string;
    try { id = newRequestId(); }
    catch (cause) { setSuiteErrors((errors) => ({ ...errors, [suite]: asApiError(cause) })); return; }
    const epoch = connectionEpoch.current;
    const controller = new AbortController(); writeController.current = controller;
    activeRun.current = id;
    lastRunIds.current[suite] = id;
    setRunningSuite(suite); setSuiteErrors((errors) => ({ ...errors, [suite]: undefined })); setNotice("");
    setRecovery({ suite, id, until: Date.now() + 240_000 });
    try {
      const response = await apiRequest<unknown>("/api/wps/acceptance", { suite, requestId: id }, { signal: controller.signal, timeoutMs: 180_000 });
      if (!isAcceptanceReport(response) || response.suite !== suite)
        throw new ApiError("未收到可核对的验收报告，正在查询原请求记录。", { code: "INVALID_ACCEPTANCE_REPORT", retryable: true });
      if (!mounted.current) return;
      const checked = epoch === connectionEpoch.current ? response : { ...response, connectionCurrent: false };
      setReports((existing) => mergeAcceptanceReports(existing, [checked]));
      if (response.status !== "running") setRecovery(null);
      if (credentialWasInvalidated(response)) onCredentialInvalidated();
    } catch (cause) {
      if (!mounted.current) return;
      const failure = asApiError(cause);
      if (!failure.requestId) failure.requestId = id;
      setSuiteErrors((errors) => ({ ...errors, [suite]: failure }));
      if (!failure.retryable) setRecovery(null);
      setNotice("验收请求未完整返回。已保留原编号并查询报告，不会自动重发创建操作。");
      if (credentialWasInvalidated(failure)) onCredentialInvalidated();
      await refreshReports();
    } finally {
      activeRun.current = null;
      if (mounted.current) setRunningSuite(null);
    }
  }

  async function copyDiagnostic(report: AcceptanceReport) {
    try { await navigator.clipboard.writeText(acceptanceDiagnostic(report)); setCopiedId(report.id); }
    catch { setNotice("复制未成功，可以在报告中查看验收编号。诊断不包含文件正文和凭据。"); }
  }

  function downloadReport(report: AcceptanceReport) {
    const url = URL.createObjectURL(new Blob([pretty(report)], { type: "application/json;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = `wps-acceptance-${report.suite}-${report.id}.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }

  const passed = Object.values(reports).filter((report) => report && acceptancePresentation(report, connected).tone === "passed").length;

  return <section id="acceptance" className="acceptance-section workspace-section" aria-labelledby="acceptance-heading">
    <div className="section-heading"><div><p className="section-kicker">CHECK A REAL RESULT</p><h2 id="acceptance-heading">先验收一份真实文件。</h2><p className="section-description">无需填写 JSON。分别新建专用测试文件，检查实际内容与基础结构；每项结果按本次报告展示。</p></div><div className="acceptance-toolbar"><span className="acceptance-count">{loaded ? <>当前连接 <strong>{passed}</strong> / 4 项基础验收通过</> : "正在读取验收记录"}</span><button className="text-button" onClick={() => void refreshReports()} disabled={loading}><RefreshCw size={14} className={loading ? "spin" : ""} />刷新报告</button></div></div>
    <div className="acceptance-scope"><ClipboardCheck size={17} /><p><strong>每个按钮都将新建对应的测试文件。</strong>验收仅操作本次新建的文件，不修改已有文件、不自动发布问卷。基础检查通过，不代表视觉排版已经验收。</p></div>
    <p className="acceptance-levels">诊断通道只检测网络；授权表示凭据已保存；验证连接检查账号读取；下方任务验收再核对实际业务结果。</p>
    {!connected && <div className="acceptance-connect-note"><span>先连接个人 WPS，再启动验收；历史报告仍可查看。</span><a href="#connection">前往连接<ArrowUpRight size={13} /></a></div>}
    {loadError && <ErrorCard error={loadError} />}
    {notice && <div className="feedback feedback-notice" role="status"><TriangleAlert size={15} /><p>{notice}</p></div>}
    <div className="acceptance-grid">
      {ACCEPTANCE_SUITES.map((suite) => {
        const spec = SUITES[suite]; const Icon = spec.icon; const report = reports[suite];
        const view = acceptancePresentation(report, connected);
        const inFlight = runningSuite === suite;
        const reportRunning = report?.connectionCurrent === true && report.status === "running";
        const recovering = recovery?.suite === suite && (!report || report.id !== recovery.id);
        const statusLabel = inFlight ? "待完成 · 正在运行" : recovering ? (recovery.until > Date.now() ? "待完成 · 正在核对记录" : "待完成 · 结果尚未确认") : !loaded && !report ? "检查记录中" : view.label;
        const tone = inFlight || recovering ? "pending" : view.tone;
        const checks = report?.checks ?? spec.checks.map((title, index) => ({ id: String(index), title, status: "skipped" as const, detail: loaded ? "尚未运行此项验收。" : "正在读取已保存的记录。" }));
        return <article className={`acceptance-card ${!view.current && report ? "is-historical" : ""}`} key={suite} aria-labelledby={`acceptance-${suite}`} aria-busy={inFlight || reportRunning}>
          <div className="acceptance-card-top"><span className="acceptance-suite-icon"><Icon size={21} /></span><span className={`acceptance-badge acceptance-${tone}`}>{(inFlight || reportRunning) && <LoaderCircle size={12} className="spin" />}{statusLabel}</span></div>
          <h3 id={`acceptance-${suite}`}>{spec.title}</h3><p className="acceptance-card-description">{spec.description}</p>
          <p className="acceptance-write-scope">将新建{spec.item} · 仅在新文件中验收{suite === "form" ? " · 不发布" : ""}</p>
          {report && !view.current && <p className="acceptance-history-note">此报告不计入当前连接的通过项。请在当前账号重新验收。</p>}
          {report && recovering && <p className="acceptance-history-note">下方保留上一份报告；本次新请求的结果尚未确认。</p>}
          <ol className="acceptance-checks">{checks.map((check) => <li key={check.id} className={`check-${check.status}`}><CheckStatus status={check.status} running={(inFlight || reportRunning) && check.detail !== "尚未开始。"} /><div><div><strong>{check.title}</strong><span>{report ? check.status === "pending" && check.detail === "尚未开始。" ? "未运行" : CHECK_LABELS[check.status] : "未运行"}</span></div><p>{check.detail}</p></div></li>)}</ol>
          {report?.error && <div className="acceptance-business-error" role="alert"><strong>{report.error.code}</strong><p>{report.error.message}</p></div>}
          {suiteErrors[suite] && <ErrorCard error={suiteErrors[suite]} />}
          {report?.artifacts.length ? <div className="acceptance-artifacts">{report.artifacts.map((artifact, index) => {
            const url = safeArtifactUrl(artifact.url);
            return <div key={`${artifact.fileId || artifact.formId || artifact.taskId || index}`}><span><FileText size={14} />{artifact.name}</span>{url ? <a href={url} target="_blank" rel="noopener noreferrer">打开<ArrowUpRight size={13} /></a> : <small>尚无可打开的链接</small>}{artifact.fileId && <code>文件 ID：{artifact.fileId}</code>}{artifact.formId && <code>草稿 ID：{artifact.formId}</code>}{artifact.taskId && <code>任务 ID：{artifact.taskId}</code>}</div>;
          })}</div> : null}
          {report?.notices?.map((text, index) => <p key={index} className="acceptance-notice">{text}</p>)}
          {report && ["pending", "uncertain"].includes(report.status) && <p className="acceptance-pending-note">本次执行已停止，结果仍需核对。刷新报告只读取记录，不会继续生成或重新创建文件。</p>}
          <div className="acceptance-card-actions"><button className="button button-primary" onClick={() => void start(suite)} disabled={!connected || !loaded || !!runningSuite || reportRunning}>{inFlight || reportRunning ? <LoaderCircle size={15} className="spin" /> : <Play size={13} />}{inFlight || reportRunning ? "验收正在进行…" : report || recovering ? "另建一份并重新验收" : `创建${spec.item}并验收`}</button>{(report || recovering) && <button className="text-button" disabled={loading} onClick={() => void refreshReports()}><RefreshCw size={13} />只读刷新报告</button>}</div>
          {recovering && !inFlight && <p className="acceptance-pending-note">原请求可能已创建文件，请先刷新报告核对。选择“另建一份”会额外创建新的测试文件。</p>}
          {recovering && <p className="acceptance-report-meta">待核对的请求 <code>{recovery.id}</code></p>}
          {report && <><p className="acceptance-report-meta">更新于 {formatDate(report.updatedAt)}<span>验收编号 <code>{report.id}</code></span></p><div className="acceptance-report-actions"><button className="text-button" onClick={() => void copyDiagnostic(report)}>{copiedId === report.id ? <Check size={12} /> : <Copy size={12} />}{copiedId === report.id ? "诊断已复制" : "复制安全诊断"}</button><button className="text-button" onClick={() => downloadReport(report)}><ArrowDownToLine size={12} />下载报告 JSON</button></div><details className="acceptance-raw"><summary>原始验收报告<ChevronDown size={13} /></summary><pre>{pretty(report)}</pre></details></>}
        </article>;
      })}
    </div>
  </section>;
}
