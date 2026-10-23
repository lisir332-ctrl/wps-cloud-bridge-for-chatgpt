import assert from "node:assert/strict";
import test from "node:test";
import { handleMcp } from "../lib/mcp-handler.ts";

function request(method: string, params?: unknown) {
  return new Request("https://example.com/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", "oai-authenticated-user-id": "test-actor" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }),
  });
}

test("public review mode lists only individually exposed tools", async () => {
  const response = await handleMcp(request("tools/list"), { PUBLIC_DIRECTORY_MODE: "1" });
  const body = await response.json() as { result: { tools: { name: string; annotations: Record<string, unknown> }[] } };
  const names = new Set(body.result.tools.map((tool) => tool.name));
  assert.ok(names.has("wps_search_files"));
  assert.ok(names.has("wps_create_document"));
  assert.ok(names.has("wps_create_presentation"));
  for (const name of ["wps_catalog_search", "wps_tool_schema", "wps_call_read", "wps_call_write",
    "wps_call_sensitive", "wps_workflow_run", "wps_run_acceptance"])
    assert.ok(!names.has(name), name);
  for (const tool of body.result.tools)
    for (const key of ["readOnlyHint", "destructiveHint", "openWorldHint"])
      assert.equal(typeof tool.annotations[key], "boolean", `${tool.name}.${key}`);
});

test("public review mode rejects hidden generic executor calls", async () => {
  const response = await handleMcp(request("tools/call", { name: "wps_call_read", arguments: {} }),
    { PUBLIC_DIRECTORY_MODE: "1" });
  const body = await response.json() as { error: { code: number } };
  assert.equal(response.status, 404);
  assert.equal(body.error.code, -32601);
});

test("private mode retains the full catalog surface", async () => {
  const response = await handleMcp(request("tools/list"), {});
  const body = await response.json() as { result: { tools: { name: string }[] } };
  assert.ok(body.result.tools.some((tool) => tool.name === "wps_catalog_search"));
});
