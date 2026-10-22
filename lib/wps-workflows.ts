import { classifyOperation, getCatalogTool, type CatalogTool, type Operation } from "./wps-catalog.ts";
import { stableJson } from "./wps-executions.ts";
import { WpsError, type McpToolResult } from "./wps-upstream.ts";
import { inspectWpsTaskState } from "./wps-result-state.ts";

type Args = Record<string, unknown>;
export type WorkflowReference = { step: string; pointer: string };
export type WorkflowStep = { id: string; tool: string; arguments: Args };
export type WorkflowPlan = { version: 1; steps: WorkflowStep[]; on_error?: "stop" };
export type WorkflowError = { step?: string; code: string; message: string; partialResult?: Record<string, unknown> };
export type WorkflowPreview = {
  valid: boolean;
  summary: { steps: number; reads: number; writes: number };
  steps: { id: string; tool: string; operation: Operation; references: WorkflowReference[]; status: "ready" | "deferred" }[];
  errors: WorkflowError[];
  notices: string[];
};
export type WorkflowStepResult = {
  id: string; tool: string; operation: Operation;
  status: "succeeded" | "failed" | "uncertain" | "pending" | "skipped";
  output?: unknown;
  error?: WorkflowError;
};
export type WorkflowRunResult = {
  status: "succeeded" | "partial" | "failed" | "uncertain" | "pending";
  steps: WorkflowStepResult[];
  preflight: WorkflowPreview;
  notices: string[];
};
export type WorkflowContext = {
  callTool: (name: string, args: Args) => Promise<McpToolResult>;
  clock?: () => number;
};

const MAX_STEPS = 20;
const MAX_JSON_BYTES = 440_000;
const MAX_NODES = 30_000;
const MAX_DEPTH = 32;
const MAX_RUN_MS = 75_000;
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const TRANSPORT_KEYS = new Set(["authorization", "accesstoken", "refreshtoken", "wpstoken", "clientsecret", "apikey", "bearertoken"]);
const SCHEMA_KEYS = new Set([
  "type", "properties", "required", "items", "enum", "const", "additionalProperties",
  "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
  "minLength", "maxLength", "minItems", "maxItems", "minProperties", "maxProperties", "uniqueItems",
  "description", "title", "default", "examples", "$schema", "$id", "deprecated", "readOnly", "writeOnly",
]);

export function isRecord(value: unknown): value is Args {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fail(code: string, message: string): never { throw new WpsError(code, message, 400); }
function invalid(message: string): never { return fail("INVALID_ARGUMENTS", message); }
function own(object: Args, key: string): boolean { return Object.hasOwn(object, key); }

export function boundedJson(value: unknown) {
  let nodes = 0;
  const seen = new Set<object>();
  const walk = (part: unknown, depth: number): void => {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) invalid("JSON 过大或嵌套过深，请缩小单次操作。");
    if (part === null || typeof part === "boolean") return;
    if (typeof part === "string") {
      if (part.length > 360_000) invalid("单个文本字段过长，请拆分内容。");
      return;
    }
    if (typeof part === "number") {
      if (!Number.isFinite(part)) invalid("JSON 数字必须为有限数值。");
      return;
    }
    if (typeof part !== "object") invalid("计划只接受 JSON 数据，不接受函数、脚本或其他可执行值。");
    if (seen.has(part)) invalid("JSON 不能含有循环引用。");
    seen.add(part);
    if (Array.isArray(part)) for (const item of part) walk(item, depth + 1);
    else {
      const proto = Object.getPrototypeOf(part);
      if (proto !== Object.prototype && proto !== null) invalid("参数必须是普通 JSON 对象。");
      for (const [key, item] of Object.entries(part)) {
        if (FORBIDDEN_KEYS.has(key)) invalid("JSON 包含保留字段。");
        walk(item, depth + 1);
      }
    }
    seen.delete(part);
  };
  walk(value, 0);
  if (new TextEncoder().encode(JSON.stringify(value)).length > MAX_JSON_BYTES) invalid("本次 JSON 超过容量限制，请拆成较小计划。");
}

function onlyKeys(value: Args, allowed: string[], label: string) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) invalid(label + "含不支持的字段。");
}

function reference(value: unknown): WorkflowReference | null {
  if (!isRecord(value) || !own(value, "$ref")) return null;
  onlyKeys(value, ["$ref"], "引用");
  const ref = value.$ref;
  if (!isRecord(ref)) invalid("$ref 必须为 {step, pointer} 对象。");
  onlyKeys(ref, ["step", "pointer"], "引用");
  if (typeof ref.step !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,47}$/.test(ref.step) ||
      typeof ref.pointer !== "string" || ref.pointer.length > 1024 ||
      (ref.pointer !== "" && !ref.pointer.startsWith("/")) || /~(?![01])/u.test(ref.pointer))
    invalid("引用须使用已有步骤 ID 和有效 JSON Pointer。");
  for (const segment of pointerParts(ref.pointer)) if (FORBIDDEN_KEYS.has(segment)) invalid("引用不能访问对象原型。");
  return { step: ref.step, pointer: ref.pointer };
}

function pointerParts(pointer: string): string[] {
  return pointer === "" ? [] : pointer.slice(1).split("/").map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function collectReferences(value: unknown, found: WorkflowReference[] = []): WorkflowReference[] {
  const ref = reference(value);
  if (ref) found.push(ref);
  else if (Array.isArray(value)) for (const item of value) collectReferences(item, found);
  else if (isRecord(value)) for (const item of Object.values(value)) collectReferences(item, found);
  return found;
}

function inspectSchema(schema: unknown, path: string, depth = 0): void {
  if (typeof schema === "boolean") return;
  if (!isRecord(schema) || depth > MAX_DEPTH) fail("SCHEMA_UNSUPPORTED", path + "的参数规则无法安全解析。");
  const unsupported = Object.keys(schema).filter((key) => !SCHEMA_KEYS.has(key));
  if (unsupported.length) fail("SCHEMA_UNSUPPORTED", "目录参数规则暂不支持 " + unsupported.join(", ") + "；已停止，未跳过校验。");
  if (isRecord(schema.properties)) for (const [key, child] of Object.entries(schema.properties)) inspectSchema(child, path + "." + key, depth + 1);
  if (schema.items !== undefined) {
    if (Array.isArray(schema.items)) fail("SCHEMA_UNSUPPORTED", "目录使用了尚未支持的元组规则。");
    inspectSchema(schema.items, path + "[]", depth + 1);
  }
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean")
    inspectSchema(schema.additionalProperties, path + ".*", depth + 1);
}

function matchesType(type: unknown, value: unknown): boolean {
  if (Array.isArray(type)) return type.some((item) => matchesType(item, value));
  if (type === undefined) return true;
  if (type === "object") return isRecord(value);
  if (type === "array") return Array.isArray(value);
  if (type === "null") return value === null;
  if (type === "integer") return typeof value === "number" && Number.isSafeInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "string" || type === "boolean") return typeof value === type;
  fail("SCHEMA_UNSUPPORTED", "目录包含未知参数类型。");
}

function validateValue(schema: unknown, value: unknown, path: string, allowRefs: boolean): void {
  if (reference(value)) {
    if (!allowRefs) invalid(path + "不能含未解析引用。");
    return;
  }
  if (schema === true) return;
  if (schema === false) invalid(path + "不允许提供值。");
  if (!isRecord(schema)) fail("SCHEMA_UNSUPPORTED", "目录参数规则不完整。");
  if (!matchesType(schema.type, value)) invalid(path + "的类型不符合官方参数规则。");
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => stableJson(item) === stableJson(value))) invalid(path + "不是可选值。");
  if (own(schema, "const") && stableJson(schema.const) !== stableJson(value)) invalid(path + "必须使用指定固定值。");
  if (typeof value === "number") {
    if ((typeof schema.minimum === "number" && value < schema.minimum) ||
        (typeof schema.maximum === "number" && value > schema.maximum) ||
        (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) ||
        (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum))
      invalid(path + "超出数值范围。");
    if (typeof schema.multipleOf === "number" &&
        (schema.multipleOf <= 0 || Math.abs(value / schema.multipleOf - Math.round(value / schema.multipleOf)) > 1e-9))
      invalid(path + "不符合数值步长。");
  }
  if (typeof value === "string") {
    if ((typeof schema.minLength === "number" && Array.from(value).length < schema.minLength) ||
        (typeof schema.maxLength === "number" && Array.from(value).length > schema.maxLength)) invalid(path + "的长度超出范围。");
  }
  if (Array.isArray(value)) {
    if ((typeof schema.minItems === "number" && value.length < schema.minItems) ||
        (typeof schema.maxItems === "number" && value.length > schema.maxItems)) invalid(path + "的条目数量超出范围。");
    if (schema.uniqueItems === true && new Set(value.map(stableJson)).size !== value.length) invalid(path + "不能包含重复条目。");
    if (schema.items !== undefined) value.forEach((item, index) => validateValue(schema.items, item, path + "[" + index + "]", allowRefs));
  }
  if (isRecord(value)) {
    const properties = isRecord(schema.properties) ? schema.properties : null;
    if (Array.isArray(schema.required)) for (const key of schema.required) {
      if (typeof key !== "string") fail("SCHEMA_UNSUPPORTED", "目录必填字段规则无效。");
      if (!own(value, key)) invalid(path + "缺少 " + key + "。");
    }
    const size = Object.keys(value).length;
    if ((typeof schema.minProperties === "number" && size < schema.minProperties) ||
        (typeof schema.maxProperties === "number" && size > schema.maxProperties)) invalid(path + "的字段数量超出范围。");
    for (const [key, child] of Object.entries(value)) {
      if (properties && own(properties, key)) validateValue(properties[key], child, path + "." + key, allowRefs);
      else if (schema.additionalProperties === false)
        invalid(path + "含官方参数规则未列出的字段 " + key.slice(0, 60) + "。");
      else if (isRecord(schema.additionalProperties)) validateValue(schema.additionalProperties, child, path + "." + key, allowRefs);
    }
  }
}

function safeUrl(value: string, label: string) {
  let parsed: URL;
  try { parsed = new URL(value); } catch { invalid(label + "必须是有效的 HTTPS 地址。"); }
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || (parsed.port && parsed.port !== "443") ||
      host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") ||
      !host.includes(".") || /^[\d.]+$/.test(host) || host.includes(":") ||
      /(?:auth_code|access_token|refresh_token|client_secret)=/i.test(parsed.search))
    invalid(label + "不能使用本地网络、IP、凭据或非标准 HTTPS 地址。");
}

/** Transport and authentication are fixed server-side; business data is never evaluated. */
function businessBoundaries(args: Args, allowRefs: boolean) {
  for (const [key, value] of Object.entries(args)) {
    const normalized = key.toLowerCase().replace(/[-_\s]/g, "");
    if (TRANSPORT_KEYS.has(normalized) || ["headers", "endpoint", "baseurl"].includes(normalized))
      invalid("业务参数不能覆盖网络连接或授权凭据。");
    if (!allowRefs || !reference(value)) {
      if ((key === "url" || key.endsWith("_url")) && typeof value === "string" && value.trim()) safeUrl(value, key);
    }
  }
}

export function validateCatalogArguments(tool: CatalogTool, args: unknown, allowRefs = false): asserts args is Args {
  boundedJson(args);
  if (!tool.executionAllowed) fail("TOOL_DISABLED", "此目录项不可作为业务操作执行：" + tool.name + "。");
  if (!isRecord(args)) invalid("arguments 必须为 JSON 对象。");
  if (!allowRefs && collectReferences(args).length) invalid("单步调用不接受步骤引用。");
  inspectSchema(tool.inputSchema, tool.name);
  validateValue(tool.inputSchema, args, "arguments", allowRefs);
  // These two official schemas place a string enum in items.enum. Enforce
  // the documented choices instead of silently losing the constraint.
  if (["sheet.update_pivot_field", "sheet.update_pivot_table"].includes(tool.name) && !reference(args.updateType)) {
    const schema = tool.inputSchema;
    const properties = isRecord(schema.properties) ? schema.properties : {};
    const updateType = isRecord(properties.updateType) ? properties.updateType : {};
    if (isRecord(updateType.items) && Array.isArray(updateType.items.enum) && args.updateType !== undefined &&
        !updateType.items.enum.includes(args.updateType)) invalid("arguments.updateType 不在官方操作枚举中。");
  }
  businessBoundaries(args, allowRefs);
}

export function findExecutableTool(name: unknown): CatalogTool {
  if (typeof name !== "string" || name.length > 512) invalid("tool 必须为目录中的精确工具名。");
  const tool = getCatalogTool(name);
  if (!tool) fail("UNKNOWN_TOOL", "未在已审阅的 WPS 目录中找到该工具，请先搜索目录。");
  if (!tool.executionAllowed) fail("TOOL_DISABLED", "该目录项不是可执行的业务能力。");
  return tool;
}

export function validateWorkflow(input: unknown): WorkflowPreview {
  const result: WorkflowPreview = {
    valid: false, summary: { steps: 0, reads: 0, writes: 0 }, steps: [], errors: [],
    notices: [
      "此预检不会调用 WPS。所有步骤先做静态检查，引用实际值将在对应步骤发出前再次校验。",
      "工作流顺序执行，遇错即停，不是事务，不会自动回滚或自动重试写入。",
      "删除、发布、分享和权限操作须走单独的敏感操作审阅入口，不能混入普通工作流。",
    ],
  };
  try {
    boundedJson(input);
    if (!isRecord(input)) invalid("计划必须是 JSON 对象。");
    onlyKeys(input, ["version", "steps", "on_error"], "计划");
    if (input.version !== 1 || (input.on_error !== undefined && input.on_error !== "stop"))
      invalid("计划 version 必须为 1，on_error 仅支持 stop。");
    if (!Array.isArray(input.steps) || input.steps.length < 1 || input.steps.length > MAX_STEPS)
      invalid("工作流必须包含 1 至 20 个步骤。");
    result.summary.steps = input.steps.length;
    const earlier = new Set<string>();
    for (const raw of input.steps) {
      let stepId: string | undefined;
      try {
        if (!isRecord(raw)) invalid("每个步骤必须是 JSON 对象。");
        onlyKeys(raw, ["id", "tool", "arguments"], "步骤");
        if (typeof raw.id !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,47}$/.test(raw.id)) invalid("步骤 id 必须是 1 至 48 位字母、数字、下划线或短横线，且以字母开始。");
        stepId = raw.id;
        if (earlier.has(stepId)) invalid("步骤 id 不能重复。");
        const tool = findExecutableTool(raw.tool);
        validateCatalogArguments(tool, raw.arguments, true);
        const refs = collectReferences(raw.arguments);
        for (const ref of refs) if (!earlier.has(ref.step)) invalid("引用只能指向此前已声明的步骤：" + ref.step + "。");
        const operation = classifyOperation(tool, raw.arguments);
        if (operation === "sensitive") fail("SENSITIVE_WORKFLOW_FORBIDDEN", "此步骤涉及敏感操作或无法确定其具体动作，必须单独预览并确认。");
        result.steps.push({ id: stepId, tool: tool.name, operation, references: refs, status: refs.length ? "deferred" : "ready" });
        if (operation === "read") result.summary.reads++; else result.summary.writes++;
      } catch (error) {
        result.errors.push({ ...(stepId ? { step: stepId } : {}), ...safeWorkflowError(error) });
      }
      if (stepId) earlier.add(stepId);
    }
  } catch (error) { result.errors.push(safeWorkflowError(error)); }
  result.valid = result.errors.length === 0;
  return result;
}

export function safeWorkflowError(error: unknown): Omit<WorkflowError, "step"> {
  const partial = error instanceof WpsError && "partialResult" in error && isRecord(error.partialResult)
    ? error.partialResult : undefined;
  return error instanceof WpsError
    ? { code: error.code, message: error.message, ...(partial ? { partialResult: partial } : {}) }
    : { code: "EXECUTION_ERROR", message: "执行遇到异常。写入可能已提交，请先只读核对，不要自动重复执行。" };
}

export function outputFromResult(result: McpToolResult): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent;
  if (result.content.length === 1) {
    try { return JSON.parse(result.content[0].text) as unknown; } catch { /* Plain text stays content. */ }
  }
  return { content: result.content };
}

export function isUncertainWrite(error: unknown, operation: Operation): boolean {
  if (operation === "read") return false;
  if (error instanceof WpsError && "partialResult" in error && error.partialResult) return true;
  return !(error instanceof WpsError && ["WPS_AUTH_EXPIRED", "CONNECTION_CHANGED", "WPS_FORBIDDEN", "WPS_PERSONAL_ACCOUNT_REQUIRED"].includes(error.code));
}

function resolveValue(value: unknown, outputs: Map<string, unknown>): unknown {
  const ref = reference(value);
  if (ref) {
    if (!outputs.has(ref.step)) fail("REFERENCE_UNAVAILABLE", "引用的前序步骤没有成功结果。");
    let result = outputs.get(ref.step);
    for (const part of pointerParts(ref.pointer)) {
      if (Array.isArray(result)) {
        if (!/^(0|[1-9]\d*)$/.test(part) || Number(part) >= result.length) fail("REFERENCE_NOT_FOUND", "引用数组位置不存在。");
        result = result[Number(part)];
      } else if (isRecord(result) && own(result, part)) result = result[part];
      else fail("REFERENCE_NOT_FOUND", "引用路径不存在；请依据真实输出检查 JSON Pointer。");
    }
    return result;
  }
  if (Array.isArray(value)) return value.map((item) => resolveValue(item, outputs));
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveValue(item, outputs)]));
  return value;
}

export async function executeWorkflow(input: unknown, context: WorkflowContext): Promise<WorkflowRunResult> {
  const preflight = validateWorkflow(input);
  const result: WorkflowRunResult = { status: "failed", steps: [], preflight, notices: [] };
  if (!preflight.valid) {
    result.notices.push("全计划预检未通过，未发起任何 WPS 操作。");
    return result;
  }
  const plan = input as WorkflowPlan;
  const outputs = new Map<string, unknown>();
  const clock = context.clock ?? Date.now;
  const startedAt = clock();
  let stopped = false;
  for (const step of plan.steps) {
    const tool = findExecutableTool(step.tool);
    let operation = classifyOperation(tool, step.arguments);
    if (stopped) { result.steps.push({ id: step.id, tool: step.tool, operation, status: "skipped" }); continue; }
    let dispatched = false;
    try {
      if (clock() - startedAt >= MAX_RUN_MS) fail("WORKFLOW_TIME_BUDGET", "本次执行时间已接近上限，后续步骤未发起。请检查已有结果后另行处理剩余步骤。");
      const args = resolveValue(step.arguments, outputs);
      validateCatalogArguments(tool, args, false);
      operation = classifyOperation(tool, args);
      if (operation === "sensitive") fail("SENSITIVE_WORKFLOW_FORBIDDEN", "引用解析后的操作属于敏感操作，未发起该步骤。");
      dispatched = true;
      const response = await context.callTool(step.tool, args);
      const output = outputFromResult(response);
      if (response.isError) {
        result.steps.push({ id: step.id, tool: step.tool, operation, status: operation === "read" ? "failed" : "uncertain", output,
          error: { code: "WPS_TOOL_ERROR", message: "WPS 返回了工具错误。请保留已执行结果，并核查写入是否部分生效。" } });
        stopped = true;
      } else {
        const task = inspectWpsTaskState(step.tool, output);
        if (task.state === "returned") {
          outputs.set(step.id, output);
          result.steps.push({ id: step.id, tool: step.tool, operation, status: "succeeded", output });
        } else {
          result.steps.push({ id: step.id, tool: step.tool, operation, status: task.state, output });
          if (task.notice) result.notices.push(task.notice);
          stopped = true;
        }
      }
    } catch (error) {
      result.steps.push({ id: step.id, tool: step.tool, operation,
        status: dispatched && isUncertainWrite(error, operation) ? "uncertain" : "failed", error: safeWorkflowError(error) });
      stopped = true;
    }
  }
  result.status = result.steps.some((step) => step.status === "uncertain") ? "uncertain"
    : result.steps.some((step) => step.status === "pending") ? "pending"
    : !stopped ? "succeeded" : result.steps.some((step) => step.status === "succeeded") ? "partial" : "failed";
  result.notices.push("已返回各步骤实际结果；不会自动回滚，也没有重试任何写入。");
  if (stopped) result.notices.push("执行已经停止。已完成步骤仍然生效；跳过的步骤未调用 WPS。");
  if (result.status === "uncertain") result.notices.push("至少一个步骤结果不确定。请使用只读工具确认实际文档或任务状态，不能把未知当作未执行。");
  return result;
}
