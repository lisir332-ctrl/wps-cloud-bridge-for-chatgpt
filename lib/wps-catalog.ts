import snapshot from "./catalog/tools.snapshot.json" with { type: "json" };
import metadata from "./catalog/metadata.json" with { type: "json" };
import reviewedPolicy from "./catalog/policy.json" with { type: "json" };

export type Operation = "read" | "write" | "sensitive";
export type CatalogCategory = "drive" | "wps" | "sheet" | "wpp" | "pdf" | "dbsheet" | "form" | "kwiki" | "otl" | "aippt";
export type CatalogTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  category: CatalogCategory;
  operation: Operation;
  capabilityNotes: string[];
  executionAllowed: boolean;
  referenceUrl: string;
};
type RawTool = { name: string; description: string; inputSchema: Record<string, unknown> };
type Selector = { field: string; allowed: string[]; read: string[]; sensitive: string[] };
type Policy = { operation: Operation; executionAllowed: boolean; basis: string; capabilityNotes: string[]; referencePath: string; selector?: Selector };
type CategoryInfo = { category: CatalogCategory; label: string; aliases: string; tips: string[] };

const REFERENCE_BASE = `${metadata.officialReferenceRepository}/blob/${metadata.officialReferenceCommit}/`;
const CATEGORY_INFO: CategoryInfo[] = [
  { category: "drive", label: "文件与协作", aliases: "文件 云盘 搜索 目录 文件夹 协作 分享 评论 标签 收藏 上传 下载 drive file", tips: ["先用list_my_files或search_files取得真实ID。", "已有link_url直接复用；下载、访问与公开分享是不同动作。", "创建超时先核实是否已有file_id，避免重复文件。"] },
  { category: "wps", label: "文字文档", aliases: "文档 文字 word docx wps 字体 段落 样式 修订 页眉", tips: ["段落通常1起，字符区间通常0起；按具体工具说明定位。", "先读原段落再定点替换，保留样式与修订。", "verb=query才可按查询分支处理；delete须单独审阅。"] },
  { category: "sheet", label: "表格", aliases: "表格 excel xlsx ksheet 公式 图表 透视表 工作表", tips: ["worksheet_id来自get_sheets_info，不能猜Sheet1的ID。", "创建用二维formula矩阵；更新用字符串formula，字段大小写也不同。", "范围读取检查warnings、5000行/50000格限制及分页。"] },
  { category: "wpp", label: "演示文稿", aliases: "ppt pptx 幻灯片 演示 文稿 母版 图形 形状", tips: ["先取得slide_id与shape_id，页序号不等于ID。", "修改模板内现有形状通常比反复新建更易保持版式。", "导出PDF可能为异步任务；WebShape插入活跃HTML按敏感操作审阅。"] },
  { category: "pdf", label: "PDF", aliases: "pdf 转换 转档 合并 拆分 提取 翻译 导出", tips: ["读正文用read_file；转Office才用pdf.convert。", "转换默认可能使用付费额度；免费模式最多前5页。", "保存jobid/task_id查询进度，不能把processing当已完成。"] },
  { category: "dbsheet", label: "多维表", aliases: "多维表 数据库 dbt dbsheet 表单 视图 记录 仪表盘", tips: ["先get_schema，再按字段类型写入；dbt不等同xlsx。", "分页记录用于全量分析，read_file概览可能不完整。", "Form视图收集与独立智能问卷是两套流程；分享范围必须显式指定。"] },
  { category: "form", label: "智能问卷", aliases: "问卷 表单 调查 收集 报名 登记 survey questionnaire form", tips: ["默认创建草稿，读取后预览；发布是独立敏感动作。", "questions是完整覆盖；当前lite输入支持14题型，不提供必填配置字段。", "当前四个工具不含独立问卷关闭、回答下载和统计接口。"] },
  { category: "kwiki", label: "知识库", aliases: "知识库 知识 wiki kwiki 目录 整理", tips: ["先定位知识库drive_id及父目录，避免跨库写入。", "云文档导入与新建文件是不同动作。", "关闭、删除、修改可见性需单独核对对象。"] },
  { category: "otl", label: "智能文档", aliases: "智能文档 otl 块 markdown html 在线 文档", tips: ["先查询目标块再插入或更新。", "convert只生成块结构，后续insert才保存内容。", "保留block_id；段落、表格、图片分别按块类型处理。"] },
  { category: "aippt", label: "AI PPT", aliases: "AI PPT 人工智能 自动生成 演示 大纲 aippt", tips: ["同一份演示复用session_id，不并发推进同一会话。", "interrupt表示等待用户答复；使用resume_interrupt继续。", "生成可能消耗额度且耗时较长；未取得generation结果不能宣称完成。"] },
];
const policies = reviewedPolicy.tools as unknown as Record<string, Policy>;
const categoryNotes = reviewedPolicy.categoryNotes as Record<CatalogCategory, string>;
const categories = new Map(CATEGORY_INFO.map((item) => [item.category, item]));

function freezeDeep<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) freezeDeep(item);
    Object.freeze(value);
  }
  return value;
}

const tools = (snapshot as unknown as RawTool[]).map((raw): CatalogTool => {
  const category = (raw.name.includes(".") ? raw.name.split(".")[0] : "drive") as CatalogCategory;
  const policy = policies[raw.name];
  if (!policy || !categories.has(category)) throw new Error(`Unreviewed catalog entry: ${raw.name}`);
  return freezeDeep({
    name: raw.name,
    description: raw.description,
    inputSchema: raw.inputSchema,
    category,
    operation: policy.operation,
    executionAllowed: policy.executionAllowed,
    capabilityNotes: [...policy.capabilityNotes, categoryNotes[category]],
    referenceUrl: REFERENCE_BASE + policy.referencePath,
  });
});
const byName = new Map(tools.map((tool) => [tool.name, tool]));
if (byName.size !== metadata.total || tools.length !== metadata.total) throw new Error("Invalid catalog snapshot count");

const searchable = new Map(tools.map((tool) => [tool.name,
  [tool.name, tool.description, categories.get(tool.category)!.aliases, ...tool.capabilityNotes].join(" ").normalize("NFKC").toLowerCase(),
]));

export function getCatalogTool(name: string): CatalogTool | undefined {
  return typeof name === "string" ? byName.get(name) : undefined;
}

export type CatalogQuery = { query?: string; category?: string; offset?: number; limit?: number };
export function listCatalog({ query, category, offset, limit }: CatalogQuery = {}) {
  const terms = typeof query === "string" ? query.slice(0, 500).normalize("NFKC").toLowerCase().trim().split(/\s+/).filter(Boolean) : [];
  const selectedCategory = typeof category === "string" ? category.toLowerCase().trim() : "";
  const start = typeof offset === "number" && Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
  const count = typeof limit === "number" && Number.isFinite(limit) ? Math.max(1, Math.min(100, Math.floor(limit))) : 25;
  const matches = tools.filter((tool) => (!selectedCategory || selectedCategory === "all" || tool.category === selectedCategory) &&
    terms.every((term) => searchable.get(tool.name)!.includes(term)));
  const items = matches.slice(start, start + count);
  return { items, total: matches.length, offset: start, limit: count, nextOffset: start + items.length < matches.length ? start + items.length : null };
}

export function catalogSummary() {
  const operations = { read: 0, write: 0, sensitive: 0 };
  for (const tool of tools) operations[tool.operation]++;
  return {
    total: tools.length,
    capturedAt: metadata.capturedAt,
    sourceUrl: metadata.sourceUrl,
    officialReferenceCommit: metadata.officialReferenceCommit,
    snapshotSha256: metadata.snapshotSha256,
    categories: CATEGORY_INFO.map(({ category, label, tips }) => ({
      category, label, count: tools.filter((tool) => tool.category === category).length,
      referenceUrl: `${REFERENCE_BASE}references/${category}.md`, tips: [...tips],
    })),
    operations,
    executionBlocked: tools.filter((tool) => !tool.executionAllowed).length,
    limitations: [...metadata.limitations],
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
const own = (object: Record<string, unknown>, key: string) => Object.prototype.hasOwnProperty.call(object, key);

/**
 * Classification is separate from schema validation and user authorization.
 * The executor must resolve workflow references, validate the result and call
 * this function again immediately before execution. Never trust caller-supplied
 * CatalogTool.operation or descriptions to grant read-only status.
 */
export function classifyOperation(toolOrName: CatalogTool | string, args: unknown = {}): Operation {
  const tool = getCatalogTool(typeof toolOrName === "string" ? toolOrName : toolOrName?.name);
  if (!tool || !tool.executionAllowed) return "sensitive";
  const policy = policies[tool.name];
  const input = record(args) ? args : {};
  const selector = policy.selector;
  if (selector) {
    const value = own(input, selector.field) ? input[selector.field] : undefined;
    // Unresolved references, missing selectors and invalid values never earn a
    // read classification; destructive branches get the stricter classification.
    if (typeof value !== "string" || !selector.allowed.includes(value))
      return selector.sensitive.length || policy.operation === "sensitive" ? "sensitive" : "write";
    if (selector.read.includes(value)) return "read";
    if (selector.sensitive.includes(value)) return "sensitive";
    if (policy.operation === "sensitive") return "sensitive";
    if (tool.name === "wps.texts.content" && value === "update" &&
      ((own(input, "content") && input.content === "") || (own(input, "text") && input.text === ""))) return "sensitive";
    return "write";
  }
  if (tool.name === "pdf.convert") return input.is_free_convert === true ? "write" : "sensitive";
  if (tool.name === "sheet.update_pivot_field" || tool.name === "sheet.update_pivot_table") {
    const action = input.updateType;
    const property = (tool.inputSchema.properties as Record<string, Record<string, unknown>>).updateType;
    const values = (property.items as { enum?: unknown[] } | undefined)?.enum ?? [];
    if (typeof action !== "string" || !values.includes(action)) return "sensitive";
    return action === "delete" || action === "clear_table" ? "sensitive" : "write";
  }
  if (tool.name === "wps.texts.replace") {
    if (input.replace_text === "") return "sensitive";
    if (Array.isArray(input.items) && input.items.some((item) => record(item) && item.dst === "")) return "sensitive";
    return "write";
  }
  if (tool.name === "form.lite.update_draft" && Array.isArray(input.questions) && input.questions.length === 0) return "sensitive";
  if (tool.name === "dbsheet.innerdoc_block_update" && record(input.arg) && input.arg.blockId === "doc") return "sensitive";
  if (tool.name === "dbsheet.innerdoc_block_batch_update" && Array.isArray(input.arg) &&
    input.arg.some((item) => record(item) && item.blockId === "doc")) return "sensitive";
  if (tool.name === "sheet.set_hyperlink" && input.hyperlink_url === "") return "sensitive";
  return policy.operation;
}
