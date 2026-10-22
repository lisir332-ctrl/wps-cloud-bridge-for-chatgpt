import assert from "node:assert/strict";
import { test } from "node:test";
import { resultLinks, withResultLinks } from "../lib/wps-result-links.ts";

test("返回 WPS 提供的云文档链接，不从 file_id 猜地址", () => {
  const links = resultLinks({ data: { file_id: "file-12345678", link_url: "https://www.kdocs.cn/l/abc12345" } });
  assert.deepEqual(links.map((item) => item.url), ["https://www.kdocs.cn/l/abc12345"]);
  assert.deepEqual(resultLinks({ data: { file_id: "file-12345678" } }), []);
});

test("草稿只返回管理链接，发布后同时返回填写链接", () => {
  const form_id = "20261023051040369033759";
  const management = `https://f.wps.cn/ksform/m/result/${form_id}`;
  assert.deepEqual(resultLinks({ data: { form_id, type: "Draft", sid: "" } }).map((item) => item.url), [management]);
  assert.deepEqual(resultLinks({ data: { form_id, type: "Release", sid: "s_12345678" } }).map((item) => item.url), [management, "https://f.wps.cn/g/s_12345678"]);
  assert.deepEqual(resultLinks({ data: { form_id, type: "Draft", sid: "s_12345678" } }).map((item) => item.url), [management]);
});

test("不返回第三方、授权页或带敏感查询参数的 URL", () => {
  const links = resultLinks({ data: { link_url: "https://www.kdocs.cn.evil.test/l/abc" }, output: [
    { link_url: "https://f.wps.cn/login" }, { link_url: "https://www.kdocs.cn/l/abc?access_token=secret" },
    { link_url: "http://www.kdocs.cn/l/abc" }, { form_id: "../bad", type: "Draft" },
  ] });
  assert.deepEqual(links, []);
});

test("在 MCP 结果里追加链接但保留原始回执", () => {
  const original = { content: [{ type: "text" as const, text: JSON.stringify({ data: { form_id: "f_12345678", type: "Draft" } }) }] };
  const result = withResultLinks(original);
  assert.equal(result.content[0]?.text, original.content[0]?.text);
  assert.equal(result.content.length, 2);
  assert.match(result.content[1]?.text || "", /https:\/\/f\.wps\.cn\/ksform\/m\/result\/f_12345678/);
  assert.equal((result.structuredContent?.links as unknown[])?.length, 1);
});
