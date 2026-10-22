import assert from "node:assert/strict";
import { test } from "node:test";
import { productGuide } from "../lib/wps-products.ts";
import { getCatalogTool } from "../lib/wps-catalog.ts";

test("截图中的 14 个产品均有明确的个人云端能力状态", () => {
  const guide = productGuide();
  assert.equal(guide.products.length, 14);
  assert.equal(guide.products.filter((item) => item.cloudStatus === "available").length, 9);
  assert.equal(guide.products.filter((item) => item.cloudStatus === "not_exposed").length, 5);
  for (const item of guide.products) for (const name of item.tools) assert.ok(getCatalogTool(name), `${item.name}: ${name}`);
});

test("本地笔记 MCP 不会被描述为云端能力，独立问卷与多维表 Form 路径分离", () => {
  const notes = productGuide("笔记").products[0];
  assert.equal(notes?.cloudStatus, "not_exposed");
  assert.match(notes?.caution || "", /本地客户端/);
  const forms = productGuide("智能表单").products[0];
  const db = productGuide("多维表格").products[0];
  assert.ok(forms?.tools.includes("form.lite.create_draft"));
  assert.ok(db?.tools.includes("dbsheet.form_get_meta"));
  assert.equal(productGuide("未知产品").found, false);
});
