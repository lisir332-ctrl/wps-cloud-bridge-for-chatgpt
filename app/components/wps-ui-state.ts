import { isRecord } from "./wps-client.ts";

const CREDENTIAL_ERRORS = new Set(["WPS_AUTH_EXPIRED", "CONNECTION_CHANGED", "SIGN_IN_REQUIRED"]);

/** Only inspect transport/workflow error positions, never a document's output. */
export function credentialWasInvalidated(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (typeof value.code === "string" && CREDENTIAL_ERRORS.has(value.code)) return true;
  if (isRecord(value.error) && typeof value.error.code === "string" && CREDENTIAL_ERRORS.has(value.error.code)) return true;
  return Array.isArray(value.steps) && value.steps.some((step) =>
    isRecord(step) && isRecord(step.error) && typeof step.error.code === "string" && CREDENTIAL_ERRORS.has(step.error.code));
}

/** An execution receipt has no original output and must not replace that output. */
export function isExecutionReceipt(value: unknown): boolean {
  return isRecord(value) && ["already_run", "unknown_after_timeout"].includes(String(value.status)) &&
    (!Array.isArray(value.steps) || value.steps.length === 0) && !Object.prototype.hasOwnProperty.call(value, "output");
}

export const ACCEPTANCE_SUITES = ["document", "spreadsheet", "presentation", "form"] as const;
export type AcceptanceSuite = typeof ACCEPTANCE_SUITES[number];
export type AcceptanceReport = {
  id: string;
  suite: AcceptanceSuite;
  status: "running" | "passed" | "failed" | "pending" | "uncertain";
  startedAt: number;
  updatedAt: number;
  checks: { id: string; title: string; status: "pending" | "passed" | "failed" | "skipped" | "uncertain"; detail: string }[];
  artifacts: { fileId?: string; formId?: string; taskId?: string; url?: string; name: string }[];
  error?: { code: string; message: string };
  connectionCurrent?: boolean;
  notices?: string[];
};
export type AcceptanceReports = Partial<Record<AcceptanceSuite, AcceptanceReport>>;

export function isAcceptanceReport(value: unknown): value is AcceptanceReport {
  return isRecord(value) && typeof value.id === "string" && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value.id) &&
    ACCEPTANCE_SUITES.includes(value.suite as AcceptanceSuite) &&
    ["running", "passed", "failed", "pending", "uncertain"].includes(String(value.status)) &&
    typeof value.startedAt === "number" && Number.isFinite(value.startedAt) &&
    typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt) &&
    Array.isArray(value.checks) && value.checks.every((check) => isRecord(check) && typeof check.id === "string" &&
      typeof check.title === "string" && typeof check.detail === "string" &&
      ["pending", "passed", "failed", "skipped", "uncertain"].includes(String(check.status))) &&
    Array.isArray(value.artifacts) && value.artifacts.every((artifact) => isRecord(artifact) && typeof artifact.name === "string" &&
      ["fileId", "formId", "taskId", "url"].every((key) => artifact[key] === undefined || typeof artifact[key] === "string")) &&
    (value.connectionCurrent === undefined || typeof value.connectionCurrent === "boolean") &&
    (value.notices === undefined || (Array.isArray(value.notices) && value.notices.every((notice) => typeof notice === "string"))) &&
    (value.error === undefined || (isRecord(value.error) && typeof value.error.code === "string" && typeof value.error.message === "string"));
}

/** A stale GET must not overwrite a newer POST result; account status can change. */
export function mergeAcceptanceReports(current: AcceptanceReports, incoming: AcceptanceReport[]): AcceptanceReports {
  const next = { ...current };
  for (const report of incoming) {
    const before = next[report.suite];
    if (!before || report.startedAt > before.startedAt || (report.id === before.id && report.updatedAt >= before.updatedAt)) next[report.suite] = report;
  }
  return next;
}

export function acceptancePresentation(report: AcceptanceReport | undefined, connected: boolean) {
  if (!report) return { label: "未运行", tone: "idle", current: false } as const;
  const current = connected && report.connectionCurrent === true;
  const status = report.status === "passed" &&
    (!report.checks.some((check) => check.status === "passed") || report.checks.some((check) => ["pending", "failed", "uncertain"].includes(check.status))) ? "pending" : report.status;
  const labels = { running: "待完成 · 正在运行", passed: "通过", failed: "失败", pending: "待完成", uncertain: "待完成 · 需核对" };
  return { label: current ? labels[status] : `历史结果 · ${labels[status]}`, tone: !current ? "historical" : status === "passed" ? "passed" : status === "failed" ? "failed" : "pending", current };
}

export function safeArtifactUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return undefined;
    return ["wps.cn", "wps.com", "kdocs.cn"].some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`)) ? url.href : undefined;
  } catch { return undefined; }
}

export function acceptanceDiagnostic(report: AcceptanceReport): string {
  const safeCode = typeof report.error?.code === "string" && /^[A-Z\d_:-]{1,100}$/i.test(report.error.code) ? report.error.code : undefined;
  return JSON.stringify({ reportId: report.id, suite: report.suite, status: report.status,
    connectionCurrent: report.connectionCurrent === true, ...(safeCode ? { code: safeCode } : {}),
    updatedAt: report.updatedAt }, null, 2);
}
