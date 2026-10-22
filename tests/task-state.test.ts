import assert from "node:assert/strict";
import test from "node:test";
import { inspectWpsTaskState } from "../lib/wps-result-state.ts";
import { executeWorkflow } from "../lib/wps-workflows.ts";

test("a pending read retains the task and prevents later writes in the same plan", async () => {
  const calls: string[] = [];
  const result = await executeWorkflow({version:1,steps:[
    {id:"read",tool:"read_file",arguments:{file_id:"known-file",format:"plain"}},
    {id:"create",tool:"create_file_with_content",arguments:{name:"后续文档",file_extension:"docx",content:"不得提前写入"}},
  ]}, {callTool:async name => {calls.push(name); return {content:[{type:"text",text:JSON.stringify({code:0,data:{status:"pending",task_id:"read-task-1"}})}]};}});
  assert.deepEqual(calls,["read_file"]);
  assert.equal(result.status,"pending");
  assert.equal(result.steps[1].status,"skipped");
  assert.equal((result.steps[0].output as {data:{task_id:string}}).data.task_id,"read-task-1");
});

test("business task status never comes from user document content or unrelated tools", () => {
  assert.equal(inspectWpsTaskState("read_file",{code:0,data:{status:"ok",content:{status:"pending",task_id:"not-a-task"}}}).state,"returned");
  assert.equal(inspectWpsTaskState("form.lite.get_form_info",{status:"pending",task_id:"business-data"}).state,"returned");
});

test("export and conversion task ids are not final files, while AI interruption remains incomplete", () => {
  assert.equal(inspectWpsTaskState("wpp.export.export.pdf",{code:0,data:{task_id:"export-1"}}).state,"pending");
  assert.equal(inspectWpsTaskState("wpp.export.export.pdf",{code:0,data:{task_id:"export-1",url:"https://wps.cn/result.pdf"}}).state,"returned");
  assert.equal(inspectWpsTaskState("pdf.convert",{code:0,data:{convert_job:{jobid:"convert-1"},file_info:{progress:32}}}).state,"pending");
  assert.equal(inspectWpsTaskState("pdf.convert_query",{code:0,data:{progress:100,result_files:[{file_id:"created-file"}]}}).state,"returned");
  assert.equal(inspectWpsTaskState("aippt.execute",{code:0,data:{session_id:"session-1",interrupt:{id:"outline-1"}}}).state,"pending");
  assert.equal(inspectWpsTaskState("pdf.merge_query",{code:0,data:{status:"failed",jobid:"failed-1"}}).state,"failed");
});

test("string zero envelopes and a unique business JSON block preserve pending state", async () => {
  const cases = [
    { content: [{ type: "text" as const, text: JSON.stringify({ code: "0", data: { status: "pending", task_id: "string-code" } }) }] },
    { content: [
      { type: "text" as const, text: "The document read is asynchronous." },
      { type: "text" as const, text: JSON.stringify({ note: "unrelated metadata" }) },
      { type: "text" as const, text: JSON.stringify({ code: 0, data: { status: "pending", task_id: "multi-block" } }) },
    ] },
  ];
  for (const response of cases) {
    const calls: string[] = [];
    const result = await executeWorkflow({ version: 1, steps: [
      { id: "read", tool: "read_file", arguments: { file_id: "known-file" } },
      { id: "write", tool: "create_empty_file", arguments: { name: "not-yet", file_extension: "docx" } },
    ] }, { callTool: async (name) => { calls.push(name); return response; } });
    assert.equal(result.status, "pending"); assert.equal(result.steps[1].status, "skipped");
    assert.deepEqual(calls, ["read_file"]);
  }
  assert.equal(inspectWpsTaskState("read_file", { code: "0", data: { status: "ok", content: "ready" } }).state, "returned");
});

test("unknown or ambiguous async results are uncertain and cannot dispatch dependent writes", async () => {
  const cases = [
    { content: [{ type: "text" as const, text: "Unrecognized response" }] },
    { content: [{ type: "text" as const, text: JSON.stringify({ code: 0, data: { status: "ok" } }) }] },
    { content: [
      { type: "text" as const, text: JSON.stringify({ code: 0, data: { status: "pending", task_id: "one" } }) },
      { type: "text" as const, text: JSON.stringify({ code: 0, data: { status: "ok", content: "conflicting result" } }) },
    ] },
  ];
  for (const response of cases) {
    let calls = 0;
    const result = await executeWorkflow({ version: 1, steps: [
      { id: "read", tool: "read_file", arguments: { file_id: "known-file" } },
      { id: "write", tool: "create_empty_file", arguments: { name: "not-yet", file_extension: "docx" } },
    ] }, { callTool: async () => { calls++; return response; } });
    assert.equal(result.status, "uncertain"); assert.equal(result.steps[0].status, "uncertain");
    assert.equal(result.steps[1].status, "skipped"); assert.equal(calls, 1);
    assert.ok(result.notices.some((notice) => notice.includes("结果不确定")));
    assert.ok(!result.notices.some((notice) => notice.includes("仍在处理")));
  }
});

test("only exact top-level business fields are interpreted, never nested document JSON", () => {
  const document = { code: 0, data: { status: "ok", content: {
    content: [{ type: "text", text: JSON.stringify({ code: 0, data: { status: "pending", task_id: "inside-document" } }) }],
    status: "failed",
  } } };
  assert.equal(inspectWpsTaskState("read_file", document).state, "returned");
  assert.equal(inspectWpsTaskState("read_file", { wrapper: { code: 0, data: { status: "pending" } } }).state, "uncertain");
  for (const value of [null, "text", { content: [{ type: "text", text: "bad JSON" }] }, { status: "failed" }])
    assert.equal(inspectWpsTaskState("form.lite.get_form_info", value).state, "returned");
});

test("WPS export and query receipts require a final artifact before returning", () => {
  for (const tool of ["wps.export", "wps.query_export", "wpp.export.export.pdf"]) {
    assert.equal(inspectWpsTaskState(tool, { code: "0", data: { task_id: "task-one" } }).state, "pending");
    assert.equal(inspectWpsTaskState(tool, { code: 0, data: { status: "processing" } }).state, "pending");
    assert.equal(inspectWpsTaskState(tool, { code: 0, data: { status: "failed" } }).state, "failed");
    assert.equal(inspectWpsTaskState(tool, { code: 0, data: { url: "https://wps.cn/result.pdf" } }).state, "returned");
    assert.equal(inspectWpsTaskState(tool, { code: 0, data: { status: "success" } }).state, "uncertain");
    assert.equal(inspectWpsTaskState(tool, { code: 0, data: {} }).state, "uncertain");
  }
});

test("scrape receipts and documented numeric progress cannot be confused with completion", () => {
  assert.deepEqual(inspectWpsTaskState("scrape_url", { job_id: "job-one" }).state, "pending");
  assert.equal(inspectWpsTaskState("scrape_url", { job_id: "job-one" }).taskId, "job-one");
  assert.equal(inspectWpsTaskState("scrape_progress", { code: 0, data: { status: 0 } }).state, "pending");
  assert.equal(inspectWpsTaskState("scrape_progress", { code: "0", data: { status: -1 } }).state, "failed");
  assert.equal(inspectWpsTaskState("scrape_progress", { code: 0, data: { status: 1, scrape_file_id: 501370651020 } }).state, "returned");
  assert.equal(inspectWpsTaskState("scrape_progress", { code: 0, data: { status: 1 } }).state, "uncertain");
  assert.equal(inspectWpsTaskState("scrape_progress", { code: 0, data: { status: "1" } }).state, "uncertain");
});

test("PDF progress and final output evidence must agree", () => {
  assert.equal(inspectWpsTaskState("pdf.convert_query", { code: 0, data: { progress: 100 } }).state, "uncertain");
  assert.equal(inspectWpsTaskState("pdf.convert_query", { code: 0, data: { progress: 100, result_files: [{}] } }).state, "uncertain");
  assert.equal(inspectWpsTaskState("pdf.convert_query", { code: 0, data: { progress: 50, result_files: [{ file_id: "partial" }] } }).state, "pending");
  assert.equal(inspectWpsTaskState("pdf.convert_query", { code: 0, data: { progress: 100, result_files: [{ file_id: "complete" }] } }).state, "returned");
  assert.equal(inspectWpsTaskState("pdf.get_translate_progress", { code: 0, data: { status: "success" } }).state, "uncertain");
  assert.equal(inspectWpsTaskState("pdf.get_translate_progress", { code: 0, data: { status: "success", result: { file_id: "translated" } } }).state, "returned");
});

test("AI PPT interaction and session-only rounds are not completed presentations", () => {
  assert.equal(inspectWpsTaskState("aippt.execute", { need_interaction: true }).state, "pending");
  assert.equal(inspectWpsTaskState("aippt.execute", { code: 0, data: { session_id: "one-round" } }).state, "uncertain");
  assert.equal(inspectWpsTaskState("aippt.execute", { code: 0, data: { generation: { download_url: "https://wps.cn/unverified-shape" } } }).state, "uncertain");
  const final = { id: "skill-one", is_partial: false, delta: { type: "upload_cloud.done", payload: { file_id: "123456", link_url: "https://www.kdocs.cn/l/completed" } } };
  assert.equal(inspectWpsTaskState("aippt.execute", final).state, "returned");
  assert.equal(inspectWpsTaskState("aippt.execute", { ...final, is_partial: true }).state, "uncertain");
});
