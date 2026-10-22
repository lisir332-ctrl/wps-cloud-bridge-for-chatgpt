export type PresentationDraft = {
  title: string;
  theme: "forest" | "ink";
  slides: { id: string; title: string; points: string }[];
};
export type PresentationInput = {
  title: string;
  theme: "forest" | "ink";
  slides: { title: string; bullets: string[] }[];
};
export type PresentationVerification = {
  status: "passed" | "pending" | "failed" | "not_run";
  detail: string;
  taskId?: string;
  error?: { code: string; message: string };
};
export type PresentationReadbackTarget = {
  presentation: PresentationInput;
  fileId: string;
  requestId: string;
  connectionVersion: number;
};

export function validPresentationId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(value);
}

export function checkedPresentationVerification(value: unknown): value is PresentationVerification {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const error = item.error as Record<string, unknown> | undefined;
  return ["passed", "pending", "failed", "not_run"].includes(String(item.status)) && typeof item.detail === "string" &&
    (item.taskId === undefined || validPresentationId(item.taskId)) &&
    (item.error === undefined || (!!error && typeof error === "object" && !Array.isArray(error) && typeof error.code === "string" && typeof error.message === "string"));
}

export function capturePresentationReadback(presentation: PresentationInput, fileId: string, requestId: string, connectionVersion: number): PresentationReadbackTarget {
  if (!validPresentationId(fileId)) throw new Error("缺少有效的已保存 PPT 文件编号。");
  return { presentation: structuredClone(presentation), fileId, requestId, connectionVersion };
}

export function canContinuePresentationReadback(target: PresentationReadbackTarget | null, requestId: string | undefined, fileId: string | undefined,
  connected: boolean, connectionVersion: number): target is PresentationReadbackTarget {
  return !!target && connected && target.connectionVersion === connectionVersion && target.requestId === requestId &&
    target.fileId === fileId && validPresentationId(target.fileId);
}

/** A passed readback has no outstanding task; pending keeps the newest task id. */
export function mergePresentationVerification(previous: PresentationVerification | undefined, next: PresentationVerification): PresentationVerification {
  if (next.status === "passed") {
    const { taskId: _completedTask, ...complete } = next;
    return complete;
  }
  if (next.status === "pending" && !next.taskId && previous?.taskId) return { ...next, taskId: previous.taskId };
  return { ...next };
}

export const normalizedText = (value: string) => value.trim().normalize("NFC");
export const characterCount = (value: string) => Array.from(normalizedText(value)).length;
export const bulletLines = (value: string) => value.split(/\r?\n/).filter((line) => line.trim().length > 0)
  .map((line) => normalizedText(line.replace(/^\s*[-•]\s+/, "")));

function textIssue(value: string, limit: number): string | undefined {
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufffe\uffff]/u.test(value) || /[\ud800-\udfff]/u.test(value))
    return "请使用单行普通文字，删除控制字符。";
  if (/<\/?[A-Za-z][^>]*>|<!--|<!DOCTYPE|<\?xml/i.test(value)) return "请填写纯文本，不使用 HTML 或 XML 标签。";
  const count = characterCount(value);
  return count < 1 || count > limit ? `请填写 1–${limit} 个字符，目前 ${count} 个。` : undefined;
}

export function checkPresentationDraft(draft: PresentationDraft): {
  presentation: PresentationInput | null;
  errors: Record<string, string>;
} {
  const errors: Record<string, string> = {};
  const title = normalizedText(draft.title);
  const titleIssue = textIssue(draft.title, 48);
  if (titleIssue) errors.title = titleIssue;
  else if (/[<>:"/\\|?*]/u.test(title) || title.startsWith(".") || title.endsWith(".") || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(title) || /\.pptx$/i.test(title))
    errors.title = "请填写普通文件标题，不含路径、文件后缀或特殊文件名字符。";
  if (draft.slides.length < 1 || draft.slides.length > 12) errors.slides = "每份演示文稿需要 1–12 页。";
  if (draft.theme !== "forest" && draft.theme !== "ink") errors.theme = "请选择林绿或墨蓝主题。";
  const slides = draft.slides.map((slide, index) => {
    const titleError = textIssue(slide.title, 32);
    if (titleError) errors[`slides.${index}.title`] = titleError;
    const bullets = bulletLines(slide.points);
    if (bullets.length < 1 || bullets.length > 5) errors[`slides.${index}.points`] = `每页填写 1–5 条要点，目前 ${bullets.length} 条。每行一条。`;
    else {
      const issue = bullets.map((bullet, bulletIndex) => { const error = textIssue(bullet, 60); return error ? `第 ${bulletIndex + 1} 条：${error}` : undefined; }).find(Boolean);
      if (issue) errors[`slides.${index}.points`] = issue;
    }
    return { title: normalizedText(slide.title), bullets };
  });
  return { presentation: Object.keys(errors).length ? null : { title, theme: draft.theme, slides }, errors };
}

export function decodePresentationBase64(value: unknown): Uint8Array {
  if (typeof value !== "string" || value.length < 8 || value.length > 16_000_000 || value.length % 4 !== 0 || !/^[A-Za-z\d+/]*={0,2}$/.test(value))
    throw new Error("未收到有效的 PPTX 文件数据。");
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04)
    throw new Error("返回内容不是可下载的 PPTX 容器。");
  return bytes;
}
