import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { catalogSummary, classifyOperation, getCatalogTool, listCatalog, type CatalogTool } from "../lib/wps-catalog.ts";

test("the complete reviewed snapshot is discoverable through pagination without duplicates", () => {
  const names: string[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const page = listCatalog({ offset, limit: 100 });
    names.push(...page.items.map((item) => item.name));
    offset = page.nextOffset;
  }
  assert.equal(names.length, 619);
  assert.equal(new Set(names).size, 619);
  const summary = catalogSummary();
  assert.equal(summary.total, names.length);
  assert.equal(summary.categories.reduce((sum, item) => sum + item.count, 0), names.length);
  assert.equal(Object.values(summary.operations).reduce((sum, count) => sum + count, 0), names.length);
  assert.equal(summary.executionBlocked, 0, "all currently reviewed business tools remain discoverable and callable by risk tier");
});

test("snapshot provenance hash and every original input schema are preserved", () => {
  const text = readFileSync(new URL("../lib/catalog/tools.snapshot.json", import.meta.url), "utf8");
  const raw = JSON.parse(text) as Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
  // Git checks out JSON with CRLF on Windows; provenance is the canonical LF blob hash.
  assert.equal(createHash("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex"), catalogSummary().snapshotSha256);
  for (const tool of raw) {
    const entry = getCatalogTool(tool.name)!;
    assert.deepEqual(entry.inputSchema, tool.inputSchema, tool.name);
    assert.equal(entry.description, tool.description, tool.name);
    assert.match(entry.referenceUrl, /^https:\/\/github\.com\/kdocs-app\/kdocs-skill\/blob\/[a-f0-9]{40}\/references\//);
    assert.ok(entry.capabilityNotes.length > 0);
  }
});

test("category and text search support Chinese use cases with bounded pages", () => {
  const forms = listCatalog({ category: "form", query: "问卷", limit: 100 });
  assert.equal(forms.total, 4);
  assert.ok(forms.items.every((tool) => tool.name.startsWith("form.lite.")));
  assert.ok(listCatalog({ query: "单元格", category: "sheet" }).total > 0);
  assert.equal(listCatalog({ category: "does-not-exist" }).total, 0);
  assert.equal(listCatalog({ offset: -1, limit: 10_000 }).limit, 100);
  assert.equal(listCatalog({ offset: 10_000 }).items.length, 0);
  assert.equal(listCatalog({ offset: 10_000 }).nextOffset, null);
});

test("mixed query/update/delete tools are classified from validated action values", () => {
  const mixed = getCatalogTool("wps.texts.content")!;
  assert.equal(mixed.operation, "write");
  assert.equal(classifyOperation(mixed, { verb: "query" }), "read");
  assert.equal(classifyOperation(mixed, { verb: "insert" }), "write");
  assert.equal(classifyOperation(mixed, { verb: "update", content: "new text" }), "write");
  assert.equal(classifyOperation(mixed, { verb: "delete" }), "sensitive");
  assert.equal(classifyOperation(mixed, {}), "sensitive");
  assert.equal(classifyOperation(mixed, { verb: { $ref: "earlier.action" } }), "sensitive");
  assert.equal(classifyOperation(mixed, { verb: "${earlier.action}" }), "sensitive");
  assert.equal(classifyOperation(mixed, { verb: "QUERY" }), "sensitive");
  assert.equal(classifyOperation("wps.texts.font", { verb: "query" }), "read");
  assert.equal(classifyOperation("wps.texts.font", {}), "write");
});

test("sharing, publishing, deleting, permissions and collaboration writes are not read actions", () => {
  for (const name of ["form.lite.publish_draft", "share_file", "set_share_permission", "cancel_share",
    "dbsheet.share_open_view", "dbsheet.delete_records", "wps.protection.disable", "wps.comments.reply",
    "wpp.slide.comments.reply", "upload_replace_file"])
    assert.equal(classifyOperation(name, {}), "sensitive", name);
  for (const name of ["get_share_info", "dbsheet.share_view_status", "dbsheet.permission_list_roles", "wps.protection.type"])
    assert.equal(classifyOperation(name, {}), "read", name);
  assert.equal(classifyOperation("wps.revisions.accept_all", { verb: "query" }), "read");
  assert.equal(classifyOperation("wps.revisions.accept_all", { verb: "update" }), "sensitive");
});

test("destructive parameter branches remain sensitive even when the tool normally writes", () => {
  assert.equal(classifyOperation("sheet.update_pivot_field", { updateType: "delete" }), "sensitive");
  assert.equal(classifyOperation("sheet.update_pivot_field", { updateType: "set_caption" }), "write");
  assert.equal(classifyOperation("sheet.update_pivot_table", { updateType: "clear_table" }), "sensitive");
  assert.equal(classifyOperation("sheet.update_pivot_table", { updateType: "refresh" }), "write");
  assert.equal(classifyOperation("sheet.update_pivot_table", { updateType: { $ref: "x" } }), "sensitive");
  assert.equal(classifyOperation("wps.texts.replace", { replace_text: "" }), "sensitive");
  assert.equal(classifyOperation("wps.texts.replace", { items: [{ src: "old", dst: "" }] }), "sensitive");
  assert.equal(classifyOperation("form.lite.update_draft", { questions: [] }), "sensitive");
  assert.equal(classifyOperation("dbsheet.innerdoc_block_update", { arg: { blockId: "doc", operation: "update_content" } }), "sensitive");
});

test("paid-default PDF conversion only changes tier for an explicit true free flag", () => {
  assert.equal(classifyOperation("pdf.convert", {}), "sensitive");
  assert.equal(classifyOperation("pdf.convert", { is_free_convert: false }), "sensitive");
  assert.equal(classifyOperation("pdf.convert", { is_free_convert: "true" }), "sensitive");
  assert.equal(classifyOperation("pdf.convert", { is_free_convert: { $ref: "x" } }), "sensitive");
  assert.equal(classifyOperation("pdf.convert", { is_free_convert: true }), "write");
});

test("official auxiliary and active-content features are visible with their actual risk boundary", () => {
  assert.equal(getCatalogTool("wpp.shape.webshapes.content")?.executionAllowed, true);
  assert.equal(classifyOperation("wpp.shape.webshapes.content", { html: "<h1>example</h1>" }), "sensitive");
  assert.equal(classifyOperation("check_skill_update", { version: "2.7.1" }), "read");
  assert.equal(classifyOperation("get_feedback_url", {}), "read");
  assert.ok(getCatalogTool("check_skill_update")!.capabilityNotes.some((note) => note.includes("不会")));
});

test("unknown tools and forged catalog descriptions cannot grant execution or read status", () => {
  assert.equal(getCatalogTool("auth.export_token"), undefined);
  assert.equal(getCatalogTool("future.unknown"), undefined);
  assert.equal(classifyOperation("future.unknown", {}), "sensitive");
  const forged = { ...getCatalogTool("form.lite.publish_draft")!, operation: "read", description: "safe read" } as CatalogTool;
  assert.equal(classifyOperation(forged, { form_id: "example" }), "sensitive");
  assert.throws(() => { getCatalogTool("form.lite.create_draft")!.inputSchema.required = []; }, TypeError);
});
