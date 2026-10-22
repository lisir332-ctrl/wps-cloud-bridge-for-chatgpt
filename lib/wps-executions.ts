import { WpsError } from "./wps-upstream.ts";

export type ExecutionStatus = "running" | "succeeded" | "partial" | "failed" | "uncertain" | "pending";
export type ExecutionRecord = {
  user_id: string;
  request_id: string;
  plan_hash: string;
  status: ExecutionStatus;
  started_at: number;
  finished_at: number | null;
};

export function requireRequestId(value: unknown): string {
  if (typeof value !== "string" ||
      !/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(value))
    throw new WpsError("REQUEST_ID_REQUIRED", "写入前请生成并保留一个 UUID requestId；网络错误后不得换 ID 自动重试。", 400);
  return value.toLowerCase();
}

/** Stable JSON is used only after bounded, JSON-only validation. */
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  const object = value as Record<string, unknown>;
  return "{" + Object.keys(object).sort().map((key) => JSON.stringify(key) + ":" + stableJson(object[key])).join(",") + "}";
}

export async function executionHash(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(stableJson(value));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class WpsExecutionLedger {
  constructor(private readonly db: D1Database) {}

  async claim(actor: string, requestId: string, planHash: string, now = Date.now()):
    Promise<{ claimed: true } | { claimed: false; record: ExecutionRecord }> {
    const result = await this.db.prepare(
      "INSERT INTO wps_executions (user_id, request_id, plan_hash, status, started_at, finished_at) " +
      "VALUES (?, ?, ?, 'running', ?, NULL) ON CONFLICT(user_id, request_id) DO NOTHING",
    ).bind(actor, requestId, planHash, now).run();
    if (result.meta.changes === 1) return { claimed: true };
    const record = await this.db.prepare(
      "SELECT * FROM wps_executions WHERE user_id=? AND request_id=?",
    ).bind(actor, requestId).first<ExecutionRecord>();
    if (!record) throw new WpsError("EXECUTION_LEDGER_UNAVAILABLE", "执行登记暂不可用，本次未发起 WPS 操作。", 503);
    if (record.plan_hash !== planHash)
      throw new WpsError("REQUEST_ID_REUSED", "此 requestId 已绑定另一份操作；请勿修改内容后复用执行 ID。", 409);
    return { claimed: false, record };
  }

  async finish(actor: string, requestId: string, status: Exclude<ExecutionStatus, "running">, now = Date.now()) {
    await this.db.prepare(
      "UPDATE wps_executions SET status=?, finished_at=? WHERE user_id=? AND request_id=? AND status='running'",
    ).bind(status, now, actor, requestId).run();
  }
}

export function repeatExecution(record: ExecutionRecord) {
  const uncertain = record.status === "running" || record.status === "uncertain";
  return {
    status: uncertain ? "unknown_after_timeout" as const : "already_run" as const,
    requestId: record.request_id,
    previousStatus: record.status,
    startedAt: record.started_at,
    finishedAt: record.finished_at,
    steps: [],
    notices: [uncertain
      ? "此请求已经发出，可能仍在执行或已完成。本服务不会重复写入；请先用只读工具检查实际状态。"
      : "此请求已经执行过，本次没有重放。为保护隐私，服务器仅保留执行状态；请查看本次会话保留的结果或只读核对文档。"],
  };
}
