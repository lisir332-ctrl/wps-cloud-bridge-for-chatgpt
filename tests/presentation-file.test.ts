import assert from "node:assert/strict";
import { inflateRawSync } from "node:zlib";
import { test } from "node:test";
import {
  generatePresentationFile, validatePresentationInput, PresentationInputError,
  type PresentationInput,
} from "../lib/wps-presentation-file.ts";

// Read the produced ZIP independently of PptxGenJS/JSZip. This checks actual
// Office package content, rather than mocking addText or the implementation.
function unzip(base64: string): Map<string, string> {
  const buffer = Buffer.from(base64, "base64");
  assert.equal(buffer.readUInt32LE(0), 0x04034b50, "PPTX must be a ZIP file");
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0, "ZIP central-directory end must exist");
  const count = buffer.readUInt16LE(end + 10);
  let cursor = buffer.readUInt32LE(end + 16);
  const files = new Map<string, string>();
  for (let index = 0; index < count; index++) {
    assert.equal(buffer.readUInt32LE(cursor), 0x02014b50);
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const expectedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    assert.equal(buffer.readUInt32LE(localOffset), 0x04034b50);
    const start = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
    const compressed = buffer.subarray(start, start + compressedSize);
    assert.ok(method === 0 || method === 8, "Only standard stored/deflated ZIP entries are expected");
    const content = method === 8 ? inflateRawSync(compressed) : compressed;
    assert.equal(content.length, expectedSize, `Complete ZIP entry ${name}`);
    assert.ok(!files.has(name), `No duplicate ZIP entry ${name}`);
    files.set(name, content.toString("utf8"));
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  assert.ok(files.has("[Content_Types].xml"));
  return files;
}

function xmlText(xml: string): string[] {
  return Array.from(xml.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g), (match) => match[1]
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, "&"));
}

function slideNames(files: Map<string, string>): string[] {
  return Array.from(files.keys()).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => Number(a.match(/slide(\d+)/)![1]) - Number(b.match(/slide(\d+)/)![1]));
}

const sample: PresentationInput = {
  title: "中文文档自动化",
  slides: [
    { title: "个人云端文档", bullets: ["文档以标准 PPTX 保存。", "文字和页面元素保持可编辑。"] },
    { title: "核对真实结果", bullets: ["创建后读取实际文件内容。", "回读标题、正文和页面数量。"] },
  ],
};

test("generated PPTX contains every requested editable title/bullet and exactly the requested slides", async () => {
  const result = await generatePresentationFile(sample);
  assert.equal(result.name, "中文文档自动化.pptx");
  assert.equal(result.slideCount, 2);
  assert.deepEqual(result.expectedTitles, sample.slides.map((slide) => slide.title));
  const files = unzip(result.contentBase64);
  const names = slideNames(files);
  assert.equal(names.length, 2, "No unrequested cover slide");
  for (const [index, name] of names.entries()) {
    const xml = files.get(name)!;
    const content = xmlText(xml);
    for (const text of [sample.slides[index].title, ...sample.slides[index].bullets, sample.title, `${index + 1} / 2`]) {
      assert.ok(content.includes(text), `${name} contains actual editable text: ${text}`);
    }
    assert.ok((xml.match(/<p:txBody>/g) ?? []).length >= 5);
    assert.ok((xml.match(/<a:buChar /g) ?? []).length >= 2, "Editable native bullets");
    assert.doesNotMatch(xml, /<p:pic>|<p:graphicFrame>|<a:hlinkClick/);
  }
  assert.match(files.get("[Content_Types].xml")!, /presentationml\.presentation\.main\+xml/);
});

test("standard wide canvas, legible typography, Chinese font metadata and bounds survive serialization", async () => {
  const longest = {
    title: "中文演示排版边界检查",
    slides: [{ title: "验".repeat(32), bullets: Array.from({ length: 5 }, (_, i) => `${i + 1}${"文".repeat(59)}`) }],
  };
  const files = unzip((await generatePresentationFile(longest)).contentBase64);
  const presentation = files.get("ppt/presentation.xml")!;
  const size = presentation.match(/<p:sldSz[^>]*cx="(\d+)"[^>]*cy="(\d+)"/)!;
  assert.ok(size);
  assert.equal(Number(size[1]) / Number(size[2]), 16 / 9);
  const xml = files.get("ppt/slides/slide1.xml")!;
  assert.match(xml, /lang="zh-CN"/);
  assert.match(xml, /<a:ea[^>]*typeface="Microsoft YaHei"/);
  assert.match(xml, /sz="3400"/);
  assert.match(xml, /sz="2200"/);
  const content = xmlText(xml);
  for (const bullet of longest.slides[0].bullets) assert.ok(content.includes(bullet));
  for (const match of xml.matchAll(/<a:xfrm[^>]*>\s*<a:off x="(\d+)" y="(\d+)"\/>\s*<a:ext cx="(\d+)" cy="(\d+)"\/>/g)) {
    assert.ok(Number(match[1]) + Number(match[3]) <= Number(size[1]), "Text box fits horizontal canvas");
    assert.ok(Number(match[2]) + Number(match[4]) <= Number(size[2]), "Text box fits vertical canvas");
  }
});

test("plain text XML characters are escaped and never create external/active content", async () => {
  const plain = `研发 & 交付：2 < 3，7 > 5，保留 "引号" 与 '单引号'`;
  let networkCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { networkCalls++; throw new Error("Network must not be used"); }) as typeof fetch;
  try {
    const result = await generatePresentationFile({
      title: "研发 & 交付",
      slides: [{ title: "文本转义", bullets: [plain, "https://example.com 仅作为普通文字显示"] }],
    });
    const files = unzip(result.contentBase64);
    assert.ok(xmlText(files.get("ppt/slides/slide1.xml")!).includes(plain));
    assert.match(files.get("ppt/slides/slide1.xml")!, /&amp;/);
    assert.match(files.get("ppt/slides/slide1.xml")!, /&lt;/);
    assert.equal(networkCalls, 0);
    for (const [name, xml] of files) {
      if (!name.endsWith("/")) assert.doesNotMatch(name, /vbaProject|embeddings|activeX|customXml|ppt\/media\//i);
      if (name.endsWith(".rels")) assert.doesNotMatch(xml, /TargetMode="External"|hyperlink|oleObject/i);
    }
  } finally { globalThis.fetch = originalFetch; }
});

test("both fixed themes export real colors without altering user content", async () => {
  const forest = unzip((await generatePresentationFile({ ...sample, theme: "forest" })).contentBase64);
  const ink = unzip((await generatePresentationFile({ ...sample, theme: "ink" })).contentBase64);
  const a = forest.get("ppt/slides/slide1.xml")!;
  const b = ink.get("ppt/slides/slide1.xml")!;
  assert.notEqual(a.match(/<p:bg>[\s\S]*?<\/p:bg>/)?.[0], b.match(/<p:bg>[\s\S]*?<\/p:bg>/)?.[0]);
  assert.deepEqual(xmlText(a), xmlText(b));
});

test("twelve-slide maximum is complete and generation does not reuse earlier slides", async () => {
  const slides = Array.from({ length: 12 }, (_, index) => ({ title: `第 ${index + 1} 页`, bullets: [`本页正文 ${index + 1}`] }));
  const file = await generatePresentationFile({ title: "十二页", slides });
  assert.equal(file.slideCount, 12);
  assert.equal(slideNames(unzip(file.contentBase64)).length, 12);
  const next = await generatePresentationFile({ title: "另一份", slides: [slides[0]] });
  assert.equal(slideNames(unzip(next.contentBase64)).length, 1);
});

test("all declared Office parts exist in a multi-slide package, including the shared master", async () => {
  const input = { title: "完整结构", slides: Array.from({ length: 12 }, (_, i) => ({ title: `页面 ${i + 1}`, bullets: ["共享有效母版"] })) };
  const files = unzip((await generatePresentationFile(input)).contentBase64);
  const contentTypes = files.get("[Content_Types].xml")!;
  assert.match(contentTypes, /xmlns="http:\/\/schemas\.openxmlformats\.org\/package\/2006\/content-types"/);
  const declaredParts = Array.from(contentTypes.matchAll(/<Override\b[^>]*PartName="([^\"]+)"[^>]*\/>/g), (match) => match[1]);
  assert.ok(declaredParts.length > 12);
  for (const name of declaredParts) assert.ok(files.has(name.slice(1)), `Declared part exists: ${name}`);
  assert.ok(declaredParts.includes("/ppt/slideMasters/slideMaster1.xml"), "Keep the real master declaration");
  const masters = Array.from(files.keys()).filter((name) => /^ppt\/slideMasters\/slideMaster\d+\.xml$/.test(name));
  assert.deepEqual(masters, ["ppt/slideMasters/slideMaster1.xml"]);
  assert.match(files.get(masters[0])!, /<p:sldMaster\b/);
  for (const name of slideNames(files)) assert.ok(declaredParts.includes(`/${name}`), `Preserve ${name}`);
});

test("clear layout limits reject overlong or empty input without truncation", async () => {
  const invalid = [
    { ...sample, title: "文".repeat(49) },
    { ...sample, slides: [] },
    { ...sample, slides: Array.from({ length: 13 }, () => sample.slides[0]) },
    { ...sample, slides: [{ title: "文".repeat(33), bullets: ["要点"] }] },
    { ...sample, slides: [{ title: "标题", bullets: ["文".repeat(61)] }] },
    { ...sample, slides: [{ title: "标题", bullets: Array(6).fill("要点") }] },
    { ...sample, slides: [{ title: "标题", bullets: [] }] },
    { ...sample, slides: [{ title: "标题", bullets: ["   "] }] },
    { ...sample, slides: [{ title: "标题", bullets: ["第一行\n第二行"] }] },
  ];
  for (const input of invalid) {
    await assert.rejects(generatePresentationFile(input), PresentationInputError);
  }
  const normalized = validatePresentationInput({ title: "  中文  ", slides: [{ title: " 标题 ", bullets: [" 要点 "] }] });
  assert.deepEqual(normalized, { title: "中文", theme: "forest", slides: [{ title: "标题", bullets: ["要点"] }] });
});

test("file paths, HTML, resources, arbitrary options and executable accessors are rejected", () => {
  for (const title of ["../report", "/tmp/report", "C:\\report", "report.pptx", "CON", "报告\u202e"]) {
    assert.throws(() => validatePresentationInput({ ...sample, title }), PresentationInputError);
  }
  for (const extra of [{ path: "/tmp/source.pptx" }, { url: "https://example.com/a.pptx" }, { html: "<p>x</p>" }, { code: "alert(1)" }]) {
    assert.throws(() => validatePresentationInput({ ...sample, ...extra }), PresentationInputError);
  }
  for (const body of ["<script>alert(1)</script>", "<b>内容</b>", "<!-- content -->", "\u0000", "\ud800"]) {
    assert.throws(() => validatePresentationInput({ ...sample, slides: [{ title: "标题", bullets: [body] }] }), PresentationInputError);
  }
  assert.throws(() => validatePresentationInput({ ...sample, slides: [{ ...sample.slides[0], image: { path: "/tmp/image.png" } }] }), PresentationInputError);
  let invoked = false;
  const malicious = { ...sample };
  Object.defineProperty(malicious, "title", { get() { invoked = true; return "不应执行"; } });
  assert.throws(() => validatePresentationInput(malicious), PresentationInputError);
  assert.equal(invoked, false);
  const arrayWithGetter: unknown[] = new Array(1);
  Object.defineProperty(arrayWithGetter, "0", { get() { invoked = true; return sample.slides[0]; } });
  assert.throws(() => validatePresentationInput({ ...sample, slides: arrayWithGetter }), PresentationInputError);
  assert.equal(invoked, false);
});
