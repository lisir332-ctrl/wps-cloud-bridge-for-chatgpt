"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUpRight, Check, ChevronDown, CircleCheck, Cloud, Copy, KeyRound, Link2, LoaderCircle, RefreshCw, ShieldCheck, Stethoscope, TriangleAlert, Unplug } from "lucide-react";
import { apiRequest, ApiError, asApiError, checkedAttempt, formatDate, retryDelay, safeDiagnostic, statusRequestRetryable, type AuthAttempt, type ConnectionStatus } from "./wps-client.ts";

type PollResult = { status: "pending" | "connected" | "cancelled" | "expired"; message?: string };
type Action = "idle" | "starting" | "canceling" | "verifying" | "disconnecting" | "saving" | "diagnosing";

export function ErrorCard({ error, retrying = false }: { error: ApiError; retrying?: boolean }) {
  const [copied, setCopied] = useState(false);
  return <div className={`feedback feedback-error ${retrying ? "is-retrying" : ""}`} role="alert">
    <TriangleAlert size={16} />
    <div className="feedback-body"><p>{error.message}</p>{retrying && <p className="feedback-retry">已保留本次授权，正在自动重试。完成 WPS 授权后请返回此页。</p>}
      <div className="diagnostic-lines"><code>{error.code}</code>{error.requestId && <span>请求编号：<code>{error.requestId}</code></span>}{error.stage && <span>阶段：<code>{error.stage}</code></span>}</div>
      <button className="text-button" onClick={async () => { try { await navigator.clipboard.writeText(safeDiagnostic(error)); setCopied(true); } catch { setCopied(false); } }}><Copy size={12} />{copied ? "诊断已复制" : "复制安全诊断"}</button>
    </div>
  </div>;
}

export default function ConnectionPanel({ onStatus, compact = false }: { onStatus?: (value: ConnectionStatus) => void; compact?: boolean }) {
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [attempt, setAttempt] = useState<AuthAttempt | null>(null);
  const [action, setAction] = useState<Action>("idle");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState("");
  const [retrying, setRetrying] = useState(false);
  const [manualToken, setManualToken] = useState("");
  const [manualOpen, setManualOpen] = useState(false);
  const mounted = useRef(true);
  const statusController = useRef<AbortController | null>(null);
  const actionController = useRef<AbortController | null>(null);
  const currentAttempt = useRef<string | null>(null);
  const identityRetryPending = useRef(false);
  const statusReadError = useRef(false);
  const autoVerifiedConnection = useRef<number | null>(null);

  const refreshStatus = useCallback(async (resume = true) => {
    statusController.current?.abort();
    const controller = new AbortController();
    statusController.current = controller;
    setLoading(true);
    const waitBeforeRetry = (milliseconds: number) => new Promise<void>((resolve) => {
      const finish = () => { clearTimeout(timer); controller.signal.removeEventListener("abort", finish); resolve(); };
      const timer = setTimeout(finish, milliseconds);
      controller.signal.addEventListener("abort", finish, { once: true });
      if (controller.signal.aborted) finish();
    });
    try {
      for (let retry = 0; ; retry++) {
        try {
          const next = await apiRequest<ConnectionStatus>("/api/wps/status", undefined, { signal: controller.signal });
          if (!mounted.current || controller.signal.aborted) return;
          identityRetryPending.current = false;
          if (statusReadError.current) { setError(null); statusReadError.current = false; }
          setStatus(next); onStatus?.(next);
          if (resume && next.pending) {
            const pending = checkedAttempt(next.pending);
            if (pending.expiresAt > Date.now() && pending.attemptId !== currentAttempt.current) {
              currentAttempt.current = pending.attemptId; setAttempt(pending); setNotice("已恢复上次授权检查，请继续完成 WPS 官方授权。");
            }
          }
          return;
        } catch (cause) {
          if (!mounted.current || controller.signal.aborted) return;
          const failure = asApiError(cause);
          if (failure.code === "SIGN_IN_REQUIRED") identityRetryPending.current = true;
          if (!statusRequestRetryable(failure) || retry >= 2) {
            statusReadError.current = true; setError(failure);
            return;
          }
          await waitBeforeRetry(350 * 2 ** retry);
        }
      }
    } finally { if (mounted.current && !controller.signal.aborted) setLoading(false); }
  }, [onStatus]);

  useEffect(() => {
    mounted.current = true;
    const refresh = setTimeout(() => void refreshStatus(), 0);
    return () => { clearTimeout(refresh); mounted.current = false; statusController.current?.abort(); actionController.current?.abort(); };
  }, [refreshStatus]);

  useEffect(() => {
    if (!compact || !status?.connected || status.upstreamVerified || !status.connectedAt || autoVerifiedConnection.current === status.connectedAt) return;
    autoVerifiedConnection.current = status.connectedAt;
    const timer = setTimeout(() => {
      void (async () => {
        try { await apiRequest("/api/wps/verify", {}, { timeoutMs: 90_000 }); await refreshStatus(false); }
        catch (cause) { if (mounted.current) setError(asApiError(cause)); }
      })();
    }, 0);
    return () => clearTimeout(timer);
  }, [compact, status?.connected, status?.upstreamVerified, status?.connectedAt, refreshStatus]);

  useEffect(() => {
    const retryWhenChatGPTReturns = () => {
      if (identityRetryPending.current && document.visibilityState === "visible") void refreshStatus(false);
    };
    window.addEventListener("focus", retryWhenChatGPTReturns);
    document.addEventListener("visibilitychange", retryWhenChatGPTReturns);
    return () => {
      window.removeEventListener("focus", retryWhenChatGPTReturns);
      document.removeEventListener("visibilitychange", retryWhenChatGPTReturns);
    };
  }, [refreshStatus]);

  useEffect(() => {
    if (!attempt) return;
    let stopped = false;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    const finish = () => {
      if (stopped) return;
      stopped = true; controller?.abort(); clearTimeout(timer);
      currentAttempt.current = null; setAttempt(null); setRetrying(false);
    };
    const deadline = setTimeout(() => {
      finish();
      setError(new ApiError("本页的授权等待窗口已结束，请重新发起连接。", { code: "AUTH_WAIT_EXPIRED" }));
    }, Math.max(0, attempt.expiresAt - Date.now()));
    const poll = async () => {
      if (stopped || Date.now() >= attempt.expiresAt) return;
      controller = new AbortController();
      try {
        const result = await apiRequest<PollResult>("/api/wps/poll", { attemptId: attempt.attemptId }, { signal: controller.signal });
        if (stopped) return;
        failures = 0; setRetrying(false); setError(null);
        if (result.status === "pending") { timer = setTimeout(poll, 2_500); return; }
        finish();
        if (result.status === "connected") {
          if (compact) {
            try {
              await apiRequest("/api/wps/verify", {}, { timeoutMs: 90_000 });
              setNotice("WPS 已连接。现在可以回到 ChatGPT 直接使用云文档。");
            } catch (cause) { setError(asApiError(cause)); }
          } else setNotice("授权已保存。点击「验证连接」，检查云端是否能读取你的文件列表。");
          await refreshStatus(false);
        } else {
          setError(new ApiError(result.message || (result.status === "cancelled" ? "本次授权已取消，可以重新连接。" : "本次授权已过期，请重新连接。"), {
            code: result.status === "cancelled" ? "AUTH_CANCELLED" : "AUTH_EXPIRED",
          }));
        }
      } catch (cause) {
        if (stopped) return;
        const failure = asApiError(cause);
        setError(failure);
        if (failure.retryable && Date.now() < attempt.expiresAt) {
          setRetrying(true); failures++;
          timer = setTimeout(poll, Math.min(retryDelay(failures), Math.max(0, attempt.expiresAt - Date.now())));
        } else { finish(); }
      }
    };
    timer = setTimeout(poll, 600);
    return () => { stopped = true; clearTimeout(timer); clearTimeout(deadline); controller?.abort(); };
  }, [attempt, refreshStatus, compact]);

  async function connect() {
    setAction("starting"); setError(null); setNotice(""); setRetrying(false);
    const controller = new AbortController(); actionController.current = controller;
    let popup: Window | null = null;
    try {
      popup = window.open("about:blank", "_blank");
      if (popup) { popup.opener = null; popup.document.title = "正在打开 WPS 官方授权"; }
    } catch { popup = null; }
    try {
      const next = checkedAttempt(await apiRequest<AuthAttempt>("/api/wps/connect", {}, { signal: controller.signal }));
      if (!mounted.current) { popup?.close(); return; }
      if (next.expiresAt <= Date.now()) throw new ApiError("授权请求已经过期，请重新连接。", { code: "AUTH_EXPIRED" });
      currentAttempt.current = next.attemptId; setAttempt(next);
      try { if (popup && !popup.closed) popup.location.href = next.authorizationUrl; } catch { popup?.close(); }
    } catch (cause) { popup?.close(); if (mounted.current) setError(asApiError(cause)); }
    finally { if (mounted.current) setAction("idle"); }
  }

  async function cancel() {
    if (!attempt) return;
    setAction("canceling"); setError(null);
    try {
      await apiRequest("/api/wps/cancel", { attemptId: attempt.attemptId });
      currentAttempt.current = null; setAttempt(null); setRetrying(false);
      setNotice("本次授权已取消，服务端不会再接收这次连接。");
      await refreshStatus(false);
    } catch (cause) { setError(asApiError(cause)); }
    finally { setAction("idle"); }
  }

  async function verify() {
    setAction("verifying"); setError(null); setNotice("");
    try {
      await apiRequest("/api/wps/verify", {}, { timeoutMs: 90_000 });
      setNotice("云文件读取已验证。文档写入、PPT 制作等能力请在下方分别运行任务验收。");
      await refreshStatus(false);
    } catch (cause) { setError(asApiError(cause)); await refreshStatus(false); }
    finally { setAction("idle"); }
  }

  async function diagnose() {
    setAction("diagnosing"); setError(null); setNotice("");
    try {
      const result = await apiRequest<{ cloudReachable: boolean; checkedAt?: number; version?: string }>("/api/wps/health");
      setNotice(result.cloudReachable ? `云端授权通道可达。此检测不读取账号或文档${result.version ? `，服务版本 ${result.version}` : ""}。` : "云端暂时未能连接 WPS 授权通道，请稍后重试。");
    } catch (cause) { setError(asApiError(cause)); }
    finally { setAction("idle"); }
  }

  async function saveManualToken(event: React.FormEvent) {
    event.preventDefault();
    const token = manualToken.trim();
    setManualToken("");
    if (!token) return;
    setAction("saving"); setError(null); setNotice("");
    try {
      await apiRequest("/api/wps/token", { token }, { secret: token, timeoutMs: 90_000 });
      setManualOpen(false);
      setNotice("手动凭据已通过检测并保存，输入框已清空。");
      await refreshStatus(false);
    } catch (cause) { setError(asApiError(cause)); }
    finally { setAction("idle"); setManualToken(""); }
  }

  async function disconnect() {
    if (!window.confirm("断开连接将删除本服务保存的 WPS 授权凭证，不会删除云文档。确定继续吗？")) return;
    setAction("disconnecting"); setError(null); setNotice("");
    try {
      await apiRequest("/api/wps/disconnect", {});
      currentAttempt.current = null; setAttempt(null);
      setNotice("连接已断开，保存的凭据已删除。WPS 云文档不受影响。");
      await refreshStatus(false);
    } catch (cause) { setError(asApiError(cause)); }
    finally { setAction("idle"); }
  }

  const connected = !!status?.connected;
  const waiting = !!attempt || action === "starting";
  const ready = status?.serviceReady === true;
  const identityMissing = error?.code === "SIGN_IN_REQUIRED";
  const busy = action !== "idle";
  const expired = status?.status === "expired";
  const title = identityMissing ? "正在恢复 ChatGPT 身份" : waiting ? "等待 WPS 授权" : connected ? (compact ? "连接成功" : status?.upstreamVerified ? "个人 WPS 访问已验证" : "授权已保存，待验证访问") : expired ? "请重新授权 WPS" : !loading && status && !ready ? "连接服务准备中" : "连接你的个人 WPS";
  const badge = identityMissing ? "等待 ChatGPT" : waiting ? (retrying ? "恢复中" : "授权中") : connected ? (compact ? "已连接" : status?.upstreamVerified ? "已授权 · 已验证访问" : "已授权 · 待验证") : expired ? "授权已失效" : loading ? "检查中" : "尚未连接";

  return <section className={`connection-card ${connected ? "is-connected" : ""} ${compact ? "is-compact" : ""}`} aria-labelledby="connection-title" aria-busy={busy || loading}>
    <div className="card-topline"><span>个人 WPS 云文档{!compact && status?.version && <small> · v{status.version}</small>}</span><span className={`status-badge ${connected && status?.upstreamVerified ? "status-green" : waiting || connected ? "status-amber" : ""}`}><span className={waiting ? "pulse-dot" : ""} />{badge}</span></div>
    <div className="wps-app-icon" aria-hidden="true"><span>W</span><span className="app-cloud"><Cloud size={14} /></span></div>
    <h2 id="connection-title">{title}</h2>
    {(!compact || !connected) && <p className="connection-description">{identityMissing ? "ChatGPT 正在恢复账号，请稍候。" : waiting ? "在 WPS 完成授权后，返回这里。" : connected ? "个人云文档授权已保存。先做一次只读验证，再去工具目录选择你需要的操作。" : "授权个人账号，即可使用云文档。"}</p>}
    {!compact && connected && <div className="connection-facts"><div><span>授权时间</span><strong>{formatDate(status?.connectedAt)}</strong></div>{status?.verifiedAt && <div><span>最近验证</span><strong>{formatDate(status.verifiedAt)}</strong></div>}{status?.expiresAt && <div><span>授权有效期至</span><strong>{formatDate(status.expiresAt)}</strong></div>}</div>}
    <div className="connection-actions">
      {connected && !waiting ? !compact && <button className="button button-primary" onClick={() => void verify()} disabled={busy}>{action === "verifying" ? <LoaderCircle size={17} className="spin" /> : <CircleCheck size={17} />}{action === "verifying" ? "正在只读验证…" : "验证连接"}<ArrowUpRight size={17} /></button> : <button className="button button-primary" onClick={() => void connect()} disabled={loading || !ready || busy || waiting || identityMissing}>{waiting ? <LoaderCircle size={18} className="spin" /> : <Link2 size={18} />}{action === "starting" ? "正在打开官方授权…" : identityMissing ? "等待 ChatGPT 恢复" : waiting ? "正在检查授权状态…" : expired ? "重新连接 WPS" : "连接个人 WPS"}<ArrowUpRight size={17} /></button>}
      {attempt && <><div className="authorization-options"><a href={attempt.authorizationUrl} target="_blank" rel="noopener noreferrer">前往官方授权<ArrowUpRight size={13} /></a><button onClick={() => void cancel()} disabled={busy}>{action === "canceling" ? "正在取消…" : "取消本次授权"}</button></div><p className="attempt-deadline">本页检查至 {formatDate(attempt.expiresAt)} · 刷新页面可以恢复</p></>}
      <div className="secondary-actions">{!compact && <><button onClick={() => { setError(null); void refreshStatus(); }} disabled={busy || loading}><RefreshCw size={13} className={loading ? "spin" : ""} />刷新状态</button><button onClick={() => void diagnose()} disabled={busy}><Stethoscope size={13} />{action === "diagnosing" ? "诊断中…" : "诊断通道"}</button></>}{connected && <button className="disconnect-button" onClick={() => void disconnect()} disabled={busy || waiting}><Unplug size={13} />断开连接</button>}</div>
    </div>
    {error && <ErrorCard error={error} retrying={retrying} />}
    {notice && !error && <div className="feedback feedback-notice" role="status"><Check size={16} /><p>{notice}</p></div>}
    {!compact && <details className="manual-connection" open={manualOpen} onToggle={(event) => { const open = event.currentTarget.open; setManualOpen(open); if (!open) setManualToken(""); }}>
      <summary><span><KeyRound size={13} />官方手动凭据备用连接</span><ChevronDown size={14} /></summary>
      <p>若浏览器授权持续失败，可在 <a href="https://www.kdocs.cn/latest" target="_blank" rel="noopener noreferrer">金山文档官网</a> 的「金山文档Skill」入口取得凭据，仅粘贴到下面的密码框。不要发送到聊天。</p>
      <form onSubmit={(event) => void saveManualToken(event)}><label htmlFor="wps-manual-token">WPS 官方凭据</label><input id="wps-manual-token" type="password" autoComplete="off" spellCheck={false} data-1p-ignore data-lpignore="true" value={manualToken} onChange={(event) => setManualToken(event.target.value)} maxLength={16_384} disabled={busy || waiting || !ready} placeholder="仅在此处粘贴，不会回显" /><button className="button button-secondary" type="submit" disabled={!manualToken.trim() || busy || waiting || !ready}>{action === "saving" ? <LoaderCircle size={15} className="spin" /> : <ShieldCheck size={15} />}验证并保存</button></form>
      <small>{waiting ? "请先取消当前授权等待，再使用手动连接。" : "提交后立即清空输入框；凭据不会保存在浏览器本地。"}</small>
    </details>}
    {!compact && <div className="connection-assurance"><ShieldCheck size={15} /><span>按当前用户隔离 · 凭证不显示在页面或聊天中</span></div>}
  </section>;
}
