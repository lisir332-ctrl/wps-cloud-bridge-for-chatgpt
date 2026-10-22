import assert from "node:assert/strict";
import test from "node:test";
import { bulletLines, canContinuePresentationReadback, capturePresentationReadback, characterCount, checkPresentationDraft, checkedPresentationVerification, decodePresentationBase64, mergePresentationVerification, type PresentationDraft } from "../app/components/presentation-client.ts";

const draft: PresentationDraft = { title: " 项目汇报 ", theme: "forest", slides: [{ id: "slide-1", title: " 当前进展 ", points: "已完成工作\n\n下一步计划" }] };

test("ordinary page forms produce precise, normalized presentation JSON", () => {
  assert.deepEqual(checkPresentationDraft(draft), { errors: {}, presentation: { title: "项目汇报", theme: "forest", slides: [{ title: "当前进展", bullets: ["已完成工作", "下一步计划"] }] } });
  assert.deepEqual(bulletLines("- 第一条\r\n• 第二条\n"), ["第一条", "第二条"]);
  assert.equal(characterCount(" e\u0301 "), 1);
  assert.equal(characterCount("😀"), 1);
});

test("page and text limits fail with field-specific feedback", () => {
  const invalid = checkPresentationDraft({ ...draft, title: "文".repeat(49), slides: [{ id: "x", title: "页".repeat(33), points: "点".repeat(61) }] });
  assert.equal(invalid.presentation, null);
  assert.ok(invalid.errors.title);
  assert.ok(invalid.errors["slides.0.title"]);
  assert.ok(invalid.errors["slides.0.points"]);
  assert.ok(checkPresentationDraft({ ...draft, slides: [] }).errors.slides);
  assert.ok(checkPresentationDraft({ ...draft, slides: Array.from({ length: 13 }, () => draft.slides[0]) }).errors.slides);
});

test("each slide needs one to five distinct lines of nonempty bullet text", () => {
  assert.ok(checkPresentationDraft({ ...draft, slides: [{ ...draft.slides[0], points: "\n \n" }] }).errors["slides.0.points"]);
  assert.ok(checkPresentationDraft({ ...draft, slides: [{ ...draft.slides[0], points: "一\n二\n三\n四\n五\n六" }] }).errors["slides.0.points"]);
  assert.equal(checkPresentationDraft({ ...draft, slides: [{ ...draft.slides[0], points: Array.from({ length: 5 }, () => "字".repeat(60)).join("\n") }] }).presentation?.slides[0].bullets.length, 5);
});

test("unsupported filenames, controls and markup are rejected before submit", () => {
  for (const title of ["../report", "CON", "report.pptx", "title.", "foo:bar", "x\n", "x\u202e"]) assert.ok(checkPresentationDraft({ ...draft, title }).errors.title);
  assert.ok(checkPresentationDraft({ ...draft, slides: [{ ...draft.slides[0], title: "<b>标题</b>" }] }).errors["slides.0.title"]);
  assert.ok(checkPresentationDraft({ ...draft, slides: [{ ...draft.slides[0], points: "<script>alert(1)</script>" }] }).errors["slides.0.points"]);
});

test("download data must be bounded base64 for a ZIP container", () => {
  const bytes = Uint8Array.of(0x50, 0x4b, 0x03, 0x04, 0, 1);
  assert.deepEqual(decodePresentationBase64(btoa(String.fromCharCode(...bytes))), bytes);
  for (const value of [undefined, "not base64", btoa("not a zip"), "A".repeat(16_000_004)]) assert.throws(() => decodePresentationBase64(value));
});

test("readback captures the original outline and does not follow later editing", () => {
  const input = checkPresentationDraft(draft).presentation!;
  const target = capturePresentationReadback(input, "original-file", "original-request", 7);
  input.title = "后来修改的标题";
  input.slides[0].title = "另一页";
  input.slides[0].bullets.push("追加的编辑内容");
  assert.equal(target.presentation.title, "项目汇报");
  assert.deepEqual(target.presentation.slides[0], { title: "当前进展", bullets: ["已完成工作", "下一步计划"] });
  assert.equal(target.fileId, "original-file");
});

test("readback is restricted to the same connected session and saved file", () => {
  const target = capturePresentationReadback(checkPresentationDraft(draft).presentation!, "original-file", "original-request", 7);
  assert.equal(canContinuePresentationReadback(target, "original-request", "original-file", true, 7), true);
  assert.equal(canContinuePresentationReadback(target, "original-request", "original-file", false, 7), false);
  assert.equal(canContinuePresentationReadback(target, "original-request", "original-file", true, 8), false);
  assert.equal(canContinuePresentationReadback(target, "different-request", "original-file", true, 7), false);
  assert.equal(canContinuePresentationReadback(target, "original-request", "different-file", true, 7), false);
  assert.equal(canContinuePresentationReadback(null, "original-request", "original-file", true, 7), false);
});

test("pending readback keeps the latest task id and a pass removes completed task ids", () => {
  const previous = { status: "pending" as const, detail: "尚在处理", taskId: "task-old" };
  const newer = mergePresentationVerification(previous, { status: "pending", detail: "继续处理", taskId: "task-new" });
  assert.equal(newer.taskId, "task-new");
  assert.equal(mergePresentationVerification(newer, { status: "pending", detail: "仍在处理" }).taskId, "task-new");
  assert.deepEqual(mergePresentationVerification(newer, { status: "passed", detail: "文字核对通过", taskId: "task-new" }), { status: "passed", detail: "文字核对通过" });
});

test("readback validation does not accept malformed task ids or success shorthand", () => {
  assert.equal(checkedPresentationVerification({ status: "pending", detail: "正在处理", taskId: "valid_task-1" }), true);
  assert.equal(checkedPresentationVerification({ status: "success", detail: "ok" }), false);
  assert.equal(checkedPresentationVerification({ status: "pending", detail: "正在处理", taskId: "https://invalid.test/" }), false);
  assert.equal(checkedPresentationVerification({ status: "not_run", detail: "未核对", error: { code: "WPS_AUTH_EXPIRED", message: "需重新授权" } }), true);
});
