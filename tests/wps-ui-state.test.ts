import assert from "node:assert/strict";
import test from "node:test";
import { acceptanceDiagnostic, acceptancePresentation, credentialWasInvalidated, isAcceptanceReport, isExecutionReceipt, mergeAcceptanceReports, safeArtifactUrl, type AcceptanceReport } from "../app/components/wps-ui-state.ts";
import { ApiError, statusRequestRetryable } from "../app/components/wps-client.ts";

const report: AcceptanceReport = {
  id: "11111111-1111-4111-8111-111111111111", suite: "document", status: "passed", startedAt: 1_800_000_000_000, updatedAt: 1_800_000_001_000,
  checks: [{ id: "readback", title: "读回正文", status: "passed", detail: "指定内容已核对" }, { id: "visual", title: "视觉排版", status: "skipped", detail: "本次未做视觉验收" }],
  artifacts: [{ name: "专用测试文件", fileId: "private-file-id", url: "https://www.kdocs.cn/l/abc" }], connectionCurrent: true,
};

test("status restoration retries missing ChatGPT identity and transient service failures only", () => {
  assert.equal(statusRequestRetryable(new ApiError("late host identity", { code: "SIGN_IN_REQUIRED", status: 401 })), true);
  assert.equal(statusRequestRetryable(new ApiError("temporary outage", { code: "HTTP_503", status: 503, retryable: true })), true);
  assert.equal(statusRequestRetryable(new ApiError("forbidden", { code: "ORIGIN_REJECTED", status: 403 })), false);
});

test("credential errors refresh status only at defined protocol positions", () => {
  assert.equal(credentialWasInvalidated({ code: "WPS_AUTH_EXPIRED" }), true);
  assert.equal(credentialWasInvalidated({ error: { code: "SIGN_IN_REQUIRED" } }), true);
  assert.equal(credentialWasInvalidated({ status: "partial", steps: [{ error: { code: "CONNECTION_CHANGED" } }] }), true);
  assert.equal(credentialWasInvalidated({ output: { error: { code: "WPS_AUTH_EXPIRED" } } }), false);
  assert.equal(credentialWasInvalidated({ steps: [{ output: { code: "WPS_AUTH_EXPIRED" } }] }), false);
});

test("registration-only receipts are distinguished from actual step output", () => {
  assert.equal(isExecutionReceipt({ status: "already_run", requestId: "original" }), true);
  assert.equal(isExecutionReceipt({ status: "already_run", requestId: "original", previousStatus: "succeeded", steps: [] }), true);
  assert.equal(isExecutionReceipt({ status: "unknown_after_timeout", requestId: "original" }), true);
  assert.equal(isExecutionReceipt({ status: "unknown_after_timeout", steps: [{ output: "actual partial result" }] }), false);
  assert.equal(isExecutionReceipt({ status: "pending", output: { task_id: "still-working" } }), false);
  assert.equal(isExecutionReceipt({ status: "succeeded", output: { status: "already_run" } }), false);
});

test("only verified current-connection basic checks count as passed", () => {
  assert.equal(acceptancePresentation(report, true).tone, "passed");
  assert.equal(acceptancePresentation({ ...report, connectionCurrent: false }, true).tone, "historical");
  assert.equal(acceptancePresentation({ ...report, connectionCurrent: undefined }, true).tone, "historical");
  assert.equal(acceptancePresentation(report, false).tone, "historical");
  assert.equal(acceptancePresentation(undefined, true).label, "未运行");
});

test("HTTP success or task creation cannot imply a passed acceptance", () => {
  assert.equal(acceptancePresentation({ ...report, status: "pending" }, true).tone, "pending");
  assert.equal(acceptancePresentation({ ...report, status: "running" }, true).tone, "pending");
  assert.equal(acceptancePresentation({ ...report, status: "uncertain" }, true).tone, "pending");
  assert.equal(acceptancePresentation({ ...report, checks: [] }, true).tone, "pending");
  assert.equal(acceptancePresentation({ ...report, checks: [{ ...report.checks[0], status: "pending" }] }, true).tone, "pending");
  assert.equal(acceptancePresentation({ ...report, checks: [{ ...report.checks[0], status: "skipped" }] }, true).tone, "pending");
});

test("stale report fetches do not overwrite a newer result; connection flags refresh", () => {
  const current = { document: report };
  const older = { ...report, updatedAt: report.updatedAt - 1, status: "running" as const };
  assert.equal(mergeAcceptanceReports(current, [older]).document?.status, "passed");
  assert.equal(mergeAcceptanceReports(current, [{ ...report, connectionCurrent: false }]).document?.connectionCurrent, false);
  const newRun = { ...report, id: "22222222-2222-4222-8222-222222222222", startedAt: report.startedAt + 100, updatedAt: report.updatedAt + 100, status: "running" as const };
  assert.equal(mergeAcceptanceReports(current, [newRun]).document?.id, newRun.id);
});

test("malformed reports and unexpected artifact shapes are rejected", () => {
  assert.equal(isAcceptanceReport(report), true);
  assert.equal(isAcceptanceReport({ ...report, checks: "all passed" }), false);
  assert.equal(isAcceptanceReport({ ...report, status: "success" }), false);
  assert.equal(isAcceptanceReport({ ...report, artifacts: [{ name: "x", fileId: {} }] }), false);
  assert.equal(isAcceptanceReport({ ...report, id: "not-a-real-run-id" }), false);
});

test("artifact links allow WPS HTTPS destinations without userinfo or lookalike hosts", () => {
  assert.equal(safeArtifactUrl("https://www.kdocs.cn/l/abc"), "https://www.kdocs.cn/l/abc");
  for (const url of ["javascript:alert(1)", "http://www.kdocs.cn/l/abc", "https://kdocs.cn.evil.test/", "https://secret@kdocs.cn/", "https://example.com/"]) assert.equal(safeArtifactUrl(url), undefined);
});

test("copied acceptance diagnostics contain no file link, file id or details", () => {
  const value = acceptanceDiagnostic({ ...report, error: { code: "READBACK_FAILED", message: "private report contents" } });
  assert.doesNotMatch(value, /kdocs|private-file-id|private report contents|指定内容|artifacts/);
  assert.deepEqual(JSON.parse(value), { reportId: report.id, suite: "document", status: "passed", connectionCurrent: true, code: "READBACK_FAILED", updatedAt: report.updatedAt });
});
