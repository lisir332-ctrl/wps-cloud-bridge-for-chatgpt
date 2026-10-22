import type { McpToolResult } from "./wps-upstream.ts";

type Link = { kind: "document" | "form_management" | "form_filling"; label: string; url: string; source: "wps_response" | "official_form_rule" };
const FORM_ID = /^[a-z\d_-]{8,128}$/i;
const DOCUMENT_FIELDS = ["link_url", "linkUrl", "file_url", "fileUrl"];

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeDocumentUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2048) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return undefined;
    if (!["kdocs.cn", "wps.cn", "wps.com"].some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))) return undefined;
    if (/(^|\/)(auth|login|callback)(\/|$)/i.test(url.pathname)) return undefined;
    if ([...url.searchParams.keys()].some((key) => /token|auth|secret|key|code|sig|password/i.test(key))) return undefined;
    return url.href;
  } catch { return undefined; }
}

/** Only use URLs or form identifiers returned by WPS; never infer a document URL from a file ID. */
export function resultLinks(value: unknown): Link[] {
  const links: Link[] = [];
  const seen = new Set<string>();
  const add = (link: Link) => { if (links.length < 8 && !seen.has(link.url)) { seen.add(link.url); links.push(link); } };
  const visit = (item: unknown, depth: number) => {
    if (depth > 7 || links.length >= 8) return;
    if (Array.isArray(item)) { for (const child of item.slice(0, 25)) visit(child, depth + 1); return; }
    if (!record(item)) return;
    for (const field of DOCUMENT_FIELDS) {
      const url = safeDocumentUrl(item[field]);
      if (url) add({ kind: "document", label: "打开 WPS 云文档", url, source: "wps_response" });
    }
    // The official personal Skill defines this owner management route for drafts and published forms.
    const formId = item.form_id;
    if (typeof formId === "string" && FORM_ID.test(formId) && (item.type === "Draft" || item.type === "Release")) {
      add({ kind: "form_management", label: "管理 WPS 问卷", url: `https://f.wps.cn/ksform/m/result/${encodeURIComponent(formId)}`, source: "official_form_rule" });
      if (item.type === "Release" && typeof item.sid === "string" && FORM_ID.test(item.sid))
        add({ kind: "form_filling", label: "填写 WPS 问卷", url: `https://f.wps.cn/g/${encodeURIComponent(item.sid)}`, source: "official_form_rule" });
    }
    for (const field of ["data", "output", "steps", "result", "structuredContent"]) if (field in item) visit(item[field], depth + 1);
  };
  visit(value, 0);
  return links;
}

export function withResultLinks(result: McpToolResult): McpToolResult {
  if (result.isError) return result;
  const links: Link[] = [];
  const seen = new Set<string>();
  const merge = (value: unknown) => { for (const link of resultLinks(value)) if (links.length < 8 && !seen.has(link.url)) { seen.add(link.url); links.push(link); } };
  merge(result.structuredContent);
  for (const block of result.content) {
    try { merge(JSON.parse(block.text)); } catch { /* Free text does not contain a structured result. */ }
  }
  if (!links.length) return result;
  return { ...result, content: [...result.content, { type: "text", text: "WPS 返回的可打开链接（仍须核对操作状态）：\n" + links.map((link) => `- ${link.label}: ${link.url}`).join("\n") }],
    structuredContent: { ...(result.structuredContent || {}), links } };
}
