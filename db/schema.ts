import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Only encrypted credentials are persisted. No document contents or request logs.
export const wpsConnections = sqliteTable("wps_connections", {
  userId: text("user_id").primaryKey(),
  connectionId: text("connection_id").notNull(),
  tokenCipher: text("token_cipher").notNull(),
  tokenIv: text("token_iv").notNull(),
  connectedAt: integer("connected_at").notNull(),
  expiresAt: integer("expires_at"),
  expired: integer("expired").notNull().default(0),
  verifiedAt: integer("verified_at"),
});

export const wpsAuthAttempts = sqliteTable("wps_auth_attempts", {
  userId: text("user_id").primaryKey(),
  attemptId: text("attempt_id").notNull(),
  codeCipher: text("code_cipher").notNull(),
  codeIv: text("code_iv").notNull(),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
  lastPollAt: integer("last_poll_at").notNull().default(0),
  leaseId: text("lease_id"),
  leaseUntil: integer("lease_until").notNull().default(0),
});

// Idempotency bookkeeping only: never document contents, arguments, or tokens.
export const wpsExecutions = sqliteTable("wps_executions", {
  userId: text("user_id").notNull(),
  requestId: text("request_id").notNull(),
  planHash: text("plan_hash").notNull(),
  status: text("status").notNull(),
  startedAt: integer("started_at").notNull(),
  finishedAt: integer("finished_at"),
}, (table) => [primaryKey({ columns: [table.userId, table.requestId] })]);

// Acceptance retains only fixed check summaries and newly created artifact IDs.
// Never persist WPS credentials, request arguments, document bodies, or raw output.
export const wpsAcceptanceRuns = sqliteTable("wps_acceptance_runs", {
  userId: text("user_id").notNull(),
  requestId: text("request_id").notNull(),
  suite: text("suite").notNull(),
  connectionId: text("connection_id").notNull(),
  status: text("status").notNull(),
  startedAt: integer("started_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  checksJson: text("checks_json").notNull(),
  artifactsJson: text("artifacts_json").notNull(),
  errorJson: text("error_json"),
}, (table) => [
  primaryKey({ columns: [table.userId, table.requestId] }),
  index("wps_acceptance_latest").on(table.userId, table.suite, table.startedAt),
]);
