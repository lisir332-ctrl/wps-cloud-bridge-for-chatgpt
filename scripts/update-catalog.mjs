#!/usr/bin/env node
/**
 * Fetch public MCP metadata into a review candidate. Never calls tools/call,
 * authenticates a user, changes the deployed snapshot or enables new tools.
 * Requires Node.js 22+ (built-in fetch).
 */
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

const SOURCE = "https://mcp-center.wps.cn/skill_hub/mcp";
const PROTOCOL = "2024-11-05";
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_PAGES = 20;
const MAX_TOOLS = 10_000;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const usage = `Usage: node scripts/update-catalog.mjs [--out NEW_DIRECTORY]

Downloads only anonymous initialize / tools/list metadata from the fixed official
WPS SkillHub endpoint. Writes a candidate snapshot, provenance and diff; never
updates lib/catalog, risk policy or deployment. New/changed tools require review.
No account login, token or document operation is performed.

Default output: outputs/catalog-candidates/<capture timestamp>/
`;

const cliArgs = process.argv.slice(2);
if (cliArgs.includes("--help") || cliArgs.includes("-h")) {
  process.stdout.write(usage);
  process.exit(0);
}
let chosenOut;
for (let index = 0; index < cliArgs.length; index++) {
  if (cliArgs[index] !== "--out" || chosenOut || !cliArgs[index + 1]) {
    throw new Error(usage);
  }
  chosenOut = cliArgs[++index];
}

let sessionId;
let nextId = 1;
let totalDownloadedBytes = 0;
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

async function readReply(response, expectedId) {
  if (!response.body) throw new Error("Metadata response has no body.");
  if (Number(response.headers.get("content-length")) > MAX_BYTES) {
    await response.body.cancel();
    throw new Error("Metadata response is too large.");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const sse = response.headers.get("content-type")?.includes("text/event-stream");
  let buffer = "";
  let bytes = 0;
  const decodeEvent = (event) => {
    const data = event.split(/\r?\n/).filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, "")).join("\n");
    if (!data) return undefined;
    const parsed = JSON.parse(data);
    return record(parsed) && parsed.id === expectedId ? parsed : undefined;
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      totalDownloadedBytes += value.byteLength;
      if (bytes > MAX_BYTES || totalDownloadedBytes > 20 * MAX_BYTES) {
        throw new Error("Metadata size limit exceeded.");
      }
      buffer += decoder.decode(value, { stream: true });
      if (sse) {
        let separator;
        while ((separator = /\r?\n\r?\n/.exec(buffer))) {
          const event = buffer.slice(0, separator.index);
          buffer = buffer.slice(separator.index + separator[0].length);
          const result = decodeEvent(event);
          if (result !== undefined) return result;
        }
      }
    }
    buffer += decoder.decode();
    if (!sse) return JSON.parse(buffer);
    const result = decodeEvent(buffer);
    if (result !== undefined) return result;
    throw new Error("No matching JSON-RPC metadata response.");
  } finally {
    void reader.cancel().catch(() => undefined);
    try { reader.releaseLock(); } catch { /* Cancellation can still be pending. */ }
  }
}

async function rpc(method, params, notification = false) {
  if (!["initialize", "notifications/initialized", "tools/list"].includes(method)) {
    throw new Error("Only public metadata methods are allowed.");
  }
  const id = notification ? undefined : nextId++;
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": PROTOCOL,
    "X-Skill-Version": "1.0.0",
    "X-Request-Source": "wps-cloud-bridge-catalog",
    "User-Agent": "wps-cloud-bridge-catalog/1.0.0",
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const response = await fetch(SOURCE, {
    method: "POST", headers, redirect: "error", signal: AbortSignal.timeout(25_000),
    body: JSON.stringify({ jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method, params }),
  });
  if (!response.ok) {
    if (response.body) void response.body.cancel().catch(() => undefined);
    throw new Error(`Public metadata request failed with HTTP ${response.status}.`);
  }
  const nextSession = response.headers.get("mcp-session-id");
  if (nextSession) sessionId = nextSession;
  if (notification) {
    if (response.body) void response.body.cancel().catch(() => undefined);
    return undefined;
  }
  const message = await readReply(response, id);
  if (!record(message) || message.id !== id || message.error || !record(message.result)) {
    throw new Error("Invalid or unsuccessful metadata JSON-RPC response.");
  }
  return message.result;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (record(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
const stable = (value) => JSON.stringify(canonical(value));

const baseline = JSON.parse(await readFile(path.join(root, "lib/catalog/tools.snapshot.json"), "utf8"));
const baselineMetadata = JSON.parse(await readFile(path.join(root, "lib/catalog/metadata.json"), "utf8"));
const initialized = await rpc("initialize", {
  protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "wps-cloud-bridge-catalog", version: "1.0.0" },
});
await rpc("notifications/initialized", {}, true);
const tools = [];
const names = new Set();
const cursors = new Set();
let cursor;
let pages = 0;
do {
  if (pages >= MAX_PAGES) throw new Error("Metadata pagination limit exceeded.");
  const result = await rpc("tools/list", cursor ? { cursor } : {});
  pages++;
  if (!Array.isArray(result.tools)) throw new Error("Metadata result does not contain a tools array.");
  for (const tool of result.tools) {
    if (!record(tool) || typeof tool.name !== "string" || !tool.name ||
      typeof tool.description !== "string" || !record(tool.inputSchema) || names.has(tool.name)) {
      throw new Error("Invalid or duplicate metadata tool definition.");
    }
    names.add(tool.name);
    tools.push(tool);
    if (tools.length > MAX_TOOLS) throw new Error("Metadata tool limit exceeded.");
  }
  cursor = result.nextCursor;
  if (cursor !== undefined && cursor !== null && cursor !== "") {
    if (typeof cursor !== "string" || cursors.has(cursor)) throw new Error("Invalid metadata cursor.");
    cursors.add(cursor);
  }
} while (cursor);
if (!tools.length) throw new Error("Refusing to save an empty metadata catalog.");

const oldByName = new Map(baseline.map((tool) => [tool.name, tool]));
const changed = tools.filter((tool) => oldByName.has(tool.name) && stable(tool) !== stable(oldByName.get(tool.name)))
  .map((tool) => {
    const before = oldByName.get(tool.name);
    return {
      name: tool.name,
      inputSchemaChanged: stable(tool.inputSchema) !== stable(before.inputSchema),
      descriptionChanged: tool.description !== before.description,
      metadataChanged: stable({ ...tool, inputSchema: null, description: null }) !==
        stable({ ...before, inputSchema: null, description: null }),
    };
  });
const diff = {
  baselineCapturedAt: baselineMetadata.capturedAt,
  baselineTotal: baseline.length, candidateTotal: tools.length,
  added: tools.filter((tool) => !oldByName.has(tool.name)).map((tool) => tool.name),
  removed: baseline.filter((tool) => !names.has(tool.name)).map((tool) => tool.name),
  changed,
  requiresManualReview: true,
};
const capturedAt = new Date().toISOString();
const output = path.resolve(root, chosenOut ?? `outputs/catalog-candidates/${capturedAt.replace(/[:.]/g, "-")}`);
const deployed = path.join(root, "lib/catalog");
if (output === deployed || output.startsWith(deployed + path.sep)) {
  throw new Error("Candidate output must not overwrite the deployed lib/catalog directory.");
}
const content = JSON.stringify(tools, null, 2) + "\n";
const provenance = {
  candidate: true, capturedAt, sourceUrl: SOURCE,
  protocolVersion: initialized.protocolVersion ?? PROTOCOL,
  serverInfo: initialized.serverInfo ?? null,
  total: tools.length, pages, authenticated: false, businessToolsCalled: 0,
  snapshotSha256: createHash("sha256").update(content).digest("hex"),
  baselineOfficialReferenceCommit: baselineMetadata.officialReferenceCommit,
  referencesRevalidated: false, policyRevalidated: false,
  reviewRequired: "Review every new/changed schema and classification before manually updating the deployed catalog.",
};
await mkdir(output, { recursive: true });
await writeFile(path.join(output, "tools.snapshot.json"), content, { flag: "wx" });
await writeFile(path.join(output, "metadata.json"), JSON.stringify(provenance, null, 2) + "\n", { flag: "wx" });
await writeFile(path.join(output, "diff.json"), JSON.stringify(diff, null, 2) + "\n", { flag: "wx" });
process.stdout.write(JSON.stringify({
  candidateDirectory: output, total: tools.length, added: diff.added.length,
  removed: diff.removed.length, changed: changed.length, deployedCatalogChanged: false,
  next: "Inspect diff.json, review raw schemas and official references, then update policy and tests manually.",
}, null, 2) + "\n");
