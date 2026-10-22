import PptxGenJS from "pptxgenjs";
import JSZip from "jszip";

export type PresentationTheme = "forest" | "ink";
export type PresentationInput = {
  title: string;
  slides: Array<{ title: string; bullets: string[] }>;
  theme?: PresentationTheme;
};
export type ValidatedPresentationInput = Omit<PresentationInput, "theme"> & { theme: PresentationTheme };
export type PresentationFile = {
  name: string;
  contentBase64: string;
  slideCount: number;
  expectedTitles: string[];
};

/** Counts are Unicode code points after trimming, not UTF-16 code units. */
export const PRESENTATION_LIMITS = Object.freeze({
  minSlides: 1,
  maxSlides: 12,
  titleCharacters: 48,
  slideTitleCharacters: 32,
  minBullets: 1,
  maxBullets: 5,
  bulletCharacters: 60,
});

// A PPTX font name is not a CSS font stack. Explicit East Asian text uses
// Microsoft YaHei and zh-CN; office viewers substitute an installed CJK font
// when it is unavailable (for example Noto Sans CJK SC / DengXian). No font is
// downloaded or embedded, and no caller-controlled font/asset option is used.
export const PRESENTATION_FONT = "Microsoft YaHei";
const THEME = {
  forest: { background: "F5F7F2", title: "173F35", body: "253D36", muted: "62756C" },
  ink: { background: "F6F7FA", title: "16243A", body: "233145", muted: "647086" },
} as const;

export class PresentationInputError extends Error {
  readonly code = "PRESENTATION_INPUT_INVALID";
  constructor(readonly field: string, message: string) {
    super(message);
    this.name = "PresentationInputError";
  }
}

function invalid(field: string, message: string): never {
  throw new PresentationInputError(field, message);
}

/** Accept JSON-shaped data only; never forward arbitrary PptxGenJS options. */
function object(value: unknown, allowed: readonly string[], field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return invalid(field, `${field} 必须是对象。`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return invalid(field, `${field} 只接受普通 JSON 对象。`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.includes(key)) {
      return invalid(field, `${field} 包含不支持的字段。仅接受标题、要点和固定主题，不接受文件路径、HTML 或资源选项。`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) return invalid(field, `${field} 不接受可执行属性。`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, maximum: number, field: string): string {
  if (typeof value !== "string") return invalid(field, `${field} 必须是纯文本字符串。`);
  // Check the original value before trimming so line breaks and control
  // characters cannot bypass the one-paragraph layout contract.
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufffe\uffff]/u.test(value) ||
    /[\ud800-\udfff]/u.test(value)) {
    return invalid(field, `${field} 不接受换行、控制字符或无效 Unicode。每条要点请单独填写。`);
  }
  if (/<\/?[A-Za-z][^>]*>|<!--|<!DOCTYPE|<\?xml/i.test(value)) {
    return invalid(field, `${field} 只接受纯文本，不接受 HTML/XML 标签。`);
  }
  const result = value.trim().normalize("NFC");
  const count = Array.from(result).length;
  if (!count || count > maximum) return invalid(field, `${field} 需为 1–${maximum} 个字符。`);
  return result;
}

function array(value: unknown, minimum: number, maximum: number, field: string): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
    value.length < minimum || value.length > maximum) {
    return invalid(field, `${field}需包含 ${minimum}–${maximum} 项。`);
  }
  if (Reflect.ownKeys(value).some((key) => key !== "length" &&
    (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length))) {
    return invalid(field, `${field} 只接受普通 JSON 数组。`);
  }
  const items: unknown[] = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor)) return invalid(field, `${field} 不接受缺项或可执行属性。`);
    items.push(descriptor.value);
  }
  return items;
}

export function validatePresentationInput(input: unknown): ValidatedPresentationInput {
  const source = object(input, ["title", "slides", "theme"], "演示文稿");
  const title = text(source.title, PRESENTATION_LIMITS.titleCharacters, "演示文稿标题");
  if (/[<>:"/\\|?*]/u.test(title) || title.startsWith(".") || title.endsWith(".") ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(title) || /\.pptx$/i.test(title)) {
    return invalid("title", "演示文稿标题需为普通文件名，不含路径、文件后缀或非法文件名字符。");
  }
  if (source.theme !== undefined && source.theme !== "forest" && source.theme !== "ink") {
    return invalid("theme", "主题仅支持 forest 或 ink。");
  }
  const slides = array(source.slides, PRESENTATION_LIMITS.minSlides, PRESENTATION_LIMITS.maxSlides, "演示页")
    .map((value: unknown, index: number) => {
    const field = `第 ${index + 1} 页`;
    const slide = object(value, ["title", "bullets"], field);
    const slideTitle = text(slide.title, PRESENTATION_LIMITS.slideTitleCharacters, `${field}标题`);
    return {
      title: slideTitle,
      bullets: array(slide.bullets, PRESENTATION_LIMITS.minBullets, PRESENTATION_LIMITS.maxBullets, `${field}要点`)
        .map((bullet: unknown, bulletIndex: number) =>
        text(bullet, PRESENTATION_LIMITS.bulletCharacters, `${field}第 ${bulletIndex + 1} 条要点`)),
    };
  });
  return { title, slides, theme: source.theme ?? "forest" };
}

/**
 * PptxGenJS 4.0.1 writes one master but declares a master for each slide in
 * [Content_Types].xml. Remove only those nonexistent master declarations from
 * our own bounded, freshly generated package; preserve every real part and
 * every other declaration. JSZip runs in memory in browsers/workerd as well.
 */
async function cleanGeneratedMasterDeclarations(base64: string): Promise<string> {
  const zip = await JSZip.loadAsync(base64, { base64: true });
  const part = zip.file("[Content_Types].xml");
  if (!part || !zip.file("ppt/slideMasters/slideMaster1.xml")) {
    throw new Error("PPTX 缺少必需的内容类型或母版。");
  }
  const original = await part.async("string");
  const cleaned = original.replace(/<Override\b[^>]*\/>/g, (declaration) => {
    const name = declaration.match(/\bPartName="(\/ppt\/slideMasters\/slideMaster[1-9]\d*\.xml)"/)?.[1];
    if (!name || zip.file(name.slice(1))) return declaration;
    if (!/\bContentType="application\/vnd\.openxmlformats-officedocument\.presentationml\.slideMaster\+xml"/.test(declaration)) {
      throw new Error("PPTX 母版的内容类型不符合预期。");
    }
    return "";
  });
  if (cleaned === original) return base64;
  zip.file("[Content_Types].xml", cleaned);
  return zip.generateAsync({ type: "base64", compression: "DEFLATE", compressionOptions: { level: 6 } });
}

/**
 * In-memory standard PPTX generation. Does not read files, request URLs,
 * evaluate code, connect to WPS, or upload anything. All visible content stays
 * editable; no cover slide or other unrequested slide is added.
 */
export async function generatePresentationFile(input: unknown): Promise<PresentationFile> {
  const validated = validatePresentationInput(input);
  const palette = THEME[validated.theme];
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";
  pptx.author = "WPS Cloud Bridge";
  pptx.subject = validated.title;
  pptx.title = validated.title;
  pptx.company = "";
  pptx.theme = { headFontFace: PRESENTATION_FONT, bodyFontFace: PRESENTATION_FONT };

  const base: PptxGenJS.TextPropsOptions = {
    fontFace: PRESENTATION_FONT, lang: "zh-CN", margin: 0,
    wrap: true, fit: "none", valign: "top", isTextBox: true,
  };
  for (const [index, content] of validated.slides.entries()) {
    const slide = pptx.addSlide();
    slide.background = { color: palette.background };
    slide.addText(content.title, {
      ...base, objectName: "Slide title", x: 0.7, y: 0.58, w: 11.93, h: 1.3,
      fontSize: 34, lineSpacingMultiple: 1.15, bold: true, color: palette.title,
    });
    content.bullets.forEach((bullet, bulletIndex) => {
      slide.addText(bullet, {
        ...base, objectName: `Bullet ${bulletIndex + 1}`,
        x: 0.86, y: 2.0 + bulletIndex * 0.93, w: 11.5, h: 0.9,
        fontSize: 22, lineSpacingMultiple: 1.15, color: palette.body,
        bullet: { indent: 18 }, paraSpaceAfter: 0, paraSpaceBefore: 0,
      });
    });
    slide.addText(validated.title, {
      ...base, objectName: "Deck title footer", x: 0.7, y: 7.02, w: 10.6, h: 0.25,
      fontSize: 12, color: palette.muted,
    });
    slide.addText(`${index + 1} / ${validated.slides.length}`, {
      ...base, objectName: "Page number", x: 11.55, y: 7.02, w: 1.08, h: 0.25,
      fontSize: 12, color: palette.muted, align: "right",
    });
  }

  const generated = await pptx.write({ outputType: "base64", compression: true });
  if (typeof generated !== "string" || !generated.startsWith("UEs")) {
    throw new Error("PPTX 生成结果不是有效的 Base64 ZIP 文件。");
  }
  const contentBase64 = await cleanGeneratedMasterDeclarations(generated);
  return {
    name: `${validated.title}.pptx`, contentBase64,
    slideCount: validated.slides.length,
    expectedTitles: validated.slides.map((slide) => slide.title),
  };
}
