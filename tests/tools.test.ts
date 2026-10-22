import test from "node:test";
import assert from "node:assert/strict";
import { prepareTool, publicTools } from "../lib/wps-tools.ts";
import { handleMcp } from "../lib/mcp-handler.ts";
import { actorFrom, requireSameOrigin } from "../lib/wps-auth.ts";

test("tool catalogue is bounded and has accurate read/write annotations", () => {
  const tools = publicTools();
  assert.equal(tools.length, 11);
  assert.equal(tools.find((tool) => tool.name === "wps_read_file")?.annotations.readOnlyHint, true);
  assert.equal(tools.find((tool) => tool.name === "wps_write_cells")?.annotations.destructiveHint, true);
  assert.equal(tools.find((tool) => tool.name === "wps_create_document")?.annotations.idempotentHint, false);
  assert.ok(tools.every((tool) => !/delete|share|token|execute/.test(tool.name)));
  assert.throws(() => prepareTool("share_file", { file_id: "example" }));
  assert.throws(() => prepareTool("wps_connection_status", { user_id: "another-user" }));
});

test("document addressing is exact and does not permit arbitrary URLs", () => {
  assert.throws(() => prepareTool("wps_read_file", {}));
  assert.throws(() => prepareTool("wps_read_file", { file_id: "123", url: "https://kdocs.cn/l/example" }));
  for (const url of ["http://kdocs.cn/l/a", "https://kdocs.cn.evil.test/l/a", "https://kdocs.cn@evil.test/l/a", "https://127.0.0.1/", "https://kdocs.cn:444/l/a", "https://mcp-center.wps.cn/kdocs-auth/auth-guide?auth_code=secret"]) {
    assert.throws(() => prepareTool("wps_read_file", { url }));
  }
  const valid = prepareTool("wps_read_file", { url: "https://www.kdocs.cn/l/example", task_id: "resume-task", format: "plain" });
  assert.deepEqual(valid.arguments, { url: "https://www.kdocs.cn/l/example", task_id: "resume-task", format: "plain", enable_upload_medias: false });
});

test("paragraph editing fixes scope and skips ambiguous matching", () => {
  const mapped = prepareTool("wps_replace_paragraphs", { file_id: "f", replacements: [{ before: "原段落", after: "修改后的段落" }] });
  assert.equal(mapped.definition.raw, "wps.texts.replace");
  assert.deepEqual(mapped.arguments, { file_id: "f", scope: "paragraphs", items: [{ src: "原段落", dst: "修改后的段落" }], skip_heading: true, skip_on_multi_match: true });
  assert.throws(() => prepareTool("wps_replace_paragraphs", { file_id: "f", scope: "documents", replacements: [] }));
  assert.throws(() => prepareTool("wps_replace_paragraphs", { file_id: "f", replacements: [{ before: "a", after: "b" }, { before: "a", after: "c" }] }));
});

test("spreadsheet create uses a matrix while updates use individual scalar operations", () => {
  const created = prepareTool("wps_create_spreadsheet", { name: "计划", rows: [["标题", "数值"], ["=not-a-formula", "-12"]] });
  assert.deepEqual(created.arguments.rangeData, [{ row_from: 0, row_to: 1, col_from: 0, col_to: 1, formula: [["标题", "数值"], ["'=not-a-formula", "-12"]] }]);
  assert.throws(() => prepareTool("wps_create_spreadsheet", { name: "计划", rows: [["a"], ["b", "c"]] }));
  const changed = prepareTool("wps_write_cells", { file_id: "f", worksheet_id: 42, cells: [{ row: 0, column: 0, value: "=1+1" }, { row: 1, column: 0, value: "=1+1", kind: "formula" }] });
  assert.equal(changed.definition.raw, "sheet.range_data_batch_update");
  assert.deepEqual(changed.arguments.range_data, [
    { row_from: 0, row_to: 0, col_from: 0, col_to: 0, op_type: "cell_operation_type_formula", formula: "'=1+1" },
    { row_from: 1, row_to: 1, col_from: 0, col_to: 0, op_type: "cell_operation_type_formula", formula: "=1+1" },
  ]);
  assert.throws(() => prepareTool("wps_write_cells", { file_id: "f", cells: [{ row: 0, column: 0, value: "x" }] }));
  assert.throws(() => prepareTool("wps_write_cells", { file_id: "f", worksheet_id: 42, cells: [{ row: 0, column: 0, value: "x" }, { row: 0, column: 0, value: "y" }] }));
});

test("read ranges are bounded, integer and explicitly tied to a worksheet", () => {
  const valid = prepareTool("wps_read_cells", { file_id: "f", worksheet_id: 42, range: { row_from: 0, row_to: 9, col_from: 0, col_to: 2 } });
  assert.deepEqual(valid.arguments.range, { rowFrom: 0, rowTo: 9, colFrom: 0, colTo: 2 });
  assert.throws(() => prepareTool("wps_read_cells", { file_id: "f", worksheet_id: 42, range: { row_from: 1, row_to: 0, col_from: 0, col_to: 1 } }));
  assert.throws(() => prepareTool("wps_read_cells", { file_id: "f", worksheet_id: 42, range: { row_from: 0, row_to: 5000, col_from: 0, col_to: 9 } }));
});

const rpc = (method: string, params?: unknown, headers: Record<string, string> = {}) => new Request("https://connector.test/mcp", {
  method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
});

test("MCP static discovery works without user credentials, but all data tools require an actor", async () => {
  const discovery = await handleMcp(rpc("server/discover"), {});
  assert.deepEqual((await discovery.json() as { result: { supportedVersions: string[] } }).result.supportedVersions, ["2026-07-28"]);
  const list = await handleMcp(rpc("tools/list"), {});
  const tools = (await list.json() as { result: { tools: { name: string }[] } }).result.tools;
  assert.equal(tools.length, 25);
  assert.ok(tools.some((tool) => tool.name === "wps_product_guide"));
  assert.ok(tools.some((tool) => tool.name === "wps_catalog_search"));
  assert.ok(tools.some((tool) => tool.name === "wps_workflow_run"));
  assert.ok(tools.some((tool) => tool.name === "wps_create_presentation"));
  assert.ok(tools.some((tool) => tool.name === "wps_run_acceptance"));
  const unauthenticated = await handleMcp(rpc("tools/call", { name: "wps_list_files", arguments: {} }, { authorization: "Bearer site-service-access" }), {});
  assert.equal(unauthenticated.status, 401);
  assert.equal((await unauthenticated.json() as { error: { data: { code: string } } }).error.data.code, "SIGN_IN_REQUIRED");
  const spoofBody = await handleMcp(rpc("tools/call", { name: "wps_list_files", arguments: { user_id: "someone-else" } }, { "oai-authenticated-user-id": "actor-a" }), {});
  const output = await spoofBody.json() as { result: { isError: boolean; content: { text: string }[] } };
  assert.equal(output.result.isError, true);
  assert.equal(JSON.parse(output.result.content[0].text).error.code, "INVALID_ARGUMENTS");
});

test("browser mutations require exact same-origin requests and actor does not come from body", () => {
  assert.throws(() => actorFrom(new Request("https://connector.test/", { headers: { authorization: "Bearer service-bypass" } })));
  assert.throws(() => requireSameOrigin(new Request("https://connector.test/", { headers: { origin: "https://evil.test" } }), { SITE_ORIGIN: "https://connector.test" }));
  assert.throws(() => requireSameOrigin(new Request("https://connector.test/"), { SITE_ORIGIN: "https://connector.test" }));
  requireSameOrigin(new Request("https://internal-worker/", { headers: { origin: "https://connector.test", "sec-fetch-site": "same-origin" } }), { SITE_ORIGIN: "https://connector.test" });
});
