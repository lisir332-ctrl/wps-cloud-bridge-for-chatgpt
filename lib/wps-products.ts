import { catalogSummary, getCatalogTool } from "./wps-catalog.ts";

type Product = {
  name: string;
  group: "Office文档" | "在线文档" | "应用服务";
  cloudStatus: "available" | "not_exposed";
  route: string;
  tools: string[];
  caution: string;
  referenceUrl: string;
};

const REF = "https://github.com/kdocs-app/kdocs-skill/blob/1c5bf7574aed4e813ba2ab01321287b47c5e772b/references/";
const PRODUCTS: Product[] = [
  { name: "文字", group: "Office文档", cloudStatus: "available", route: "创建或定位 DOCX → 读取段落及样式 → 定点写入 → 读回 → 返回 WPS 链接", tools: ["create_file_with_content", "read_file", "wps.texts.content", "wps.texts.replace"], caution: "格式与修订以实际工具 schema 和读回为准。", referenceUrl: REF + "wps.md" },
  { name: "演示", group: "Office文档", cloudStatus: "available", route: "创建 PPTX → 取得 slide_id/shape_id → 编辑页面 → 读回 → 返回链接", tools: ["create_empty_file", "wpp.slide.items.list", "wpp.slide.items.insert"], caution: "页序号不等于 slide_id；视觉排版仍要预览。", referenceUrl: REF + "wpp.md" },
  { name: "表格", group: "Office文档", cloudStatus: "available", route: "创建 XLSX → 获取工作表 ID → 写入公式或格式 → 同时核对公式和值", tools: ["create_file_with_content", "sheet.get_sheets_info", "sheet.get_range_data"], caution: "更新须依据返回的 worksheet_id，不能猜工作表编号。", referenceUrl: REF + "sheet.md" },
  { name: "PDF", group: "Office文档", cloudStatus: "available", route: "上传或读取 PDF → 按需转换/导出 → 查询异步任务 → 返回结果链接", tools: ["upload_new_file", "read_file", "pdf.convert"], caution: "转换可能消耗会员额度；免费转换可能截断页数。", referenceUrl: REF + "pdf.md" },
  { name: "智能文档", group: "在线文档", cloudStatus: "available", route: "创建 OTL → 读取块 → 按块插入或编辑 → 读回", tools: ["create_file_with_content", "otl.block_query"], caution: "块转换结果不等于已保存内容；保存后再次读取。", referenceUrl: REF + "otl.md" },
  { name: "智能表格", group: "在线文档", cloudStatus: "available", route: "以 ksheet 创建云表格 → 取得工作表信息 → 单元格读写 → 回读", tools: ["create_file_with_content", "sheet.get_sheets_info", "sheet.get_range_data"], caution: "ksheet 与 xlsx 同属表格操作，但具体功能以 schema 为准。", referenceUrl: REF + "sheet.md" },
  { name: "智能表单", group: "在线文档", cloudStatus: "available", route: "创建草稿 → 读取 14 种支持题型 → 编辑草稿 → 确认后发布 → 返回管理及填写链接", tools: ["form.lite.create_draft", "form.lite.get_form_info", "form.lite.update_draft", "form.lite.publish_draft"], caution: "发布后 lite 接口不能修改；不要推断网页全部题型已开放。", referenceUrl: REF + "form.md" },
  { name: "多维表格", group: "应用服务", cloudStatus: "available", route: "创建 DBT → 读取 schema → 操作字段、记录和视图；Form 视图独立配置", tools: ["create_file_with_content", "dbsheet.get_schema", "dbsheet.create_view", "dbsheet.form_get_meta"], caution: "多维表 Form 视图与独立智能表单是不同对象；分享单独授权。", referenceUrl: REF + "dbsheet.md" },
  { name: "思维导图", group: "应用服务", cloudStatus: "not_exposed", route: "当前个人云端 SkillHub 没有原生可编辑思维导图工具", tools: [], caution: "可讨论替代交付格式，但不能称为 WPS 原生思维导图。", referenceUrl: "https://ww.kdocs.cn/welcome" },
  { name: "流程图", group: "应用服务", cloudStatus: "not_exposed", route: "当前个人云端 SkillHub 没有原生可编辑流程图工具", tools: [], caution: "上传图片只是云文件，不等于可编辑流程图。", referenceUrl: "https://ww.kdocs.cn/welcome" },
  { name: "海报", group: "应用服务", cloudStatus: "not_exposed", route: "当前个人云端 SkillHub 没有 WPS 海报设计编辑工具", tools: [], caution: "不能把 PNG 上传描述为 WPS 海报原生编辑。", referenceUrl: "https://pay.kdocs.cn/" },
  { name: "语音速记", group: "应用服务", cloudStatus: "not_exposed", route: "当前个人云端 SkillHub 没有语音速记录制或转写工具", tools: [], caution: "不能把笔记产品的本地 MCP 当作云端授权能力。", referenceUrl: "https://ainote.kdocs.cn/wps-notes-hub/tutorial/getstarted/" },
  { name: "AIPPT", group: "应用服务", cloudStatus: "available", route: "复用同一 session_id 分轮生成 → 处理中断 → 等待完成 → 核对云端演示", tools: ["aippt.execute"], caution: "可能消耗权益；返回 interrupt 或 task ID 时尚未完成。", referenceUrl: REF + "aippt.md" },
  { name: "笔记", group: "应用服务", cloudStatus: "not_exposed", route: "当前个人云端 SkillHub 没有 WPS 笔记读写接口", tools: [], caution: "WPS 笔记的单独 MCP 依赖本地客户端，与本连接器的云端方式不同。", referenceUrl: "https://ainote.kdocs.cn/wps-notes-hub/tutorial/getstarted/" },
];

/** The product map is guidance; each call still checks its live schema and account response. */
export function productGuide(product?: string) {
  const selected = product ? PRODUCTS.filter((item) => item.name.toLowerCase() === product.trim().toLowerCase()) : PRODUCTS;
  return {
    catalogCapturedAt: catalogSummary().capturedAt,
    accountEntitlements: "unknown",
    requestedProduct: product ?? null,
    found: selected.length > 0,
    products: selected.map((item) => ({ ...item, tools: item.tools.filter((name) => !!getCatalogTool(name)) })),
    rule: "只有目录中的个人云端工具可执行；产品网页按钮、企业 OpenAPI、本地客户端 MCP 不能自动视为当前连接可用。操作后读回并返回 WPS 实际链接。",
  };
}
