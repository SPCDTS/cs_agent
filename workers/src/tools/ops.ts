import { copyJson } from "@earendil-works/chord";
import type { Context } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type ToolExecutionApi, type ToolExecutionResult } from "@earendil-works/pi-durable";
import type { Env } from "../env";
import { healthReport } from "../admin/health";
import { threadView } from "../admin/read-views";
import { classifyError } from "../shared/diagnostics";

export type OpsExtensionDeps = {
  env: Env;
  allowed(api: ToolExecutionApi, context: Context): Promise<boolean>;
  currentTurnId(api: ToolExecutionApi, context: Context): Promise<string | undefined>;
  audit(detail: { tool: string; result: string }): Promise<unknown>;
};

const MAX_OUTPUT_BYTES = 48_000;
const structuredSchema = Type.Record(Type.String(), Type.Unknown());
const THREAD_PATTERN = "^(owner|(group|private):[1-9][0-9]{4,15})$";
const PURPOSE_SCHEMA = Type.Union([
  Type.Literal("conversation"),
  Type.Literal("background"),
  Type.Literal("subagent"),
  Type.Literal("compaction"),
]);
const STATUS_SCHEMA = Type.Union([
  Type.Literal("running"),
  Type.Literal("done"),
  Type.Literal("error"),
  Type.Literal("aborted"),
  Type.Literal("interrupted"),
]);

function clipDeep(value: unknown, maxChars = 6000, maxItems = 100, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    return value.length <= maxChars ? value : value.slice(0, maxChars) + `\n[已截断，原长 ${value.length} 字符]`;
  }
  if (typeof value !== "object") return value;
  if (depth >= 8) return "[depth_truncated]";
  if (Array.isArray(value)) return value.slice(0, maxItems).map(item => clipDeep(item, maxChars, maxItems, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = clipDeep(v, maxChars, maxItems, depth + 1);
  return out;
}

function okResult(value: Record<string, unknown>): ToolExecutionResult {
  const encoder = new TextEncoder();
  for (const [maxChars, maxItems] of [[6000, 100], [1200, 40], [300, 15]] as const) {
    const candidate = clipDeep(value, maxChars, maxItems);
    const serialized = JSON.stringify(candidate);
    if (encoder.encode(serialized).byteLength <= MAX_OUTPUT_BYTES) {
      const plain = copyJson(JSON.parse(serialized));
      return { structuredOutput: plain, output: [{ type: "text", text: serialized }] };
    }
  }
  const fallback = {
    truncated: true,
    note: `输出超过 ${MAX_OUTPUT_BYTES} 字节上限，已缩减为顶层字段摘要；请缩小 limit/时间范围或保持 summaryOnly=true。`,
    keys: Object.keys(value),
  };
  const serialized = JSON.stringify(fallback);
  return { structuredOutput: copyJson(fallback), output: [{ type: "text", text: serialized }] };
}

function errResult(message: string): ToolExecutionResult {
  return { isError: true, output: [{ type: "text", text: message }] };
}

export function createOpsExtension(deps: OpsExtensionDeps) {
  const guard = async (
    tool: string,
    api: ToolExecutionApi,
    context: Context,
    work: () => Promise<Record<string, unknown>>,
  ): Promise<ToolExecutionResult> => {
    let result = "error";
    try {
      if (!await deps.allowed(api, context)) {
        result = "denied";
        return errResult("ops_denied：仅限主人交互会话读取实例运行状态与诊断数据。");
      }
      const value = await work();
      result = "ok";
      return okResult(value);
    } catch (error) {
      const info = classifyError(error);
      const code = info.code ?? info.errorName ?? "ops_query_failed";
      result = code;
      return errResult(`ops_error：${code}`);
    } finally {
      await deps.audit({ tool, result }).catch(() => {});
    }
  };

  const healthTool = {
    ...defineTool({
      name: "ops_health",
      description: "查看当前实例整体健康摘要（Bridge 连接、模型状态、MCP 调用健康度、定时任务、外部事件来源、沙箱容器遥测及未关闭告警）。深入查询用量费用、慢请求轨迹、工具调用详情或错误日志请在 codemode 中调用 tools.ops_usage / tools.ops_requests / tools.ops_inspect / tools.ops_logs。",
      parameters: Type.Object({}, { additionalProperties: false }),
      structuredOutputSchema: structuredSchema,
      replay: "safe",
      execute: (_args, api, context) => guard("ops_health", api, context, async () => {
        const [report, activeAlerts] = await Promise.all([
          healthReport(deps.env),
          deps.env.REGISTRY.getByName("main").activeAlerts(10).catch(() => []),
        ]);
        return {
          ...report,
          activeAlerts,
        };
      }),
    }),
    callers: ["model", "tools"] as const,
  };

  const codemodeTools = [
    defineTool({
      name: "ops_usage",
      description: "统计指定时间窗内的模型请求量、失败数、输入/输出/缓存/推理 Token、估算费用（costUsd）、平均耗时（avgDuration）与平均首字延迟（avgTtft），按模型与时间桶汇总。",
      parameters: Type.Object({
        hours: Type.Optional(Type.Integer({ minimum: 1, maximum: 720, description: "回溯小时数，默认 24，最大 720（30 天）。" })),
        thread: Type.Optional(Type.String({ pattern: THREAD_PATTERN })),
        model: Type.Optional(Type.String({ minLength: 1, maxLength: 120, description: "provider/model，如 google/gemini-3-flash-preview。" })),
        purpose: Type.Optional(PURPOSE_SCHEMA),
      }, { additionalProperties: false }),
      structuredOutputSchema: structuredSchema,
      replay: "safe",
      execute: (args, api, context) => guard("ops_usage", api, context, async () => {
        const now = Date.now(), hours = args.hours ?? 24;
        const data = await deps.env.REQUESTS.getByName("main").usage({
          since: now - hours * 3600_000,
          until: now,
          thread: args.thread,
          model: args.model,
          purpose: args.purpose,
          limit: 50,
        });
        return { windowHours: hours, ...data };
      }),
    }),
    defineTool({
      name: "ops_requests",
      description: "列出近期模型请求记录（默认在 SQL 层排除当前回合自身请求以避免自观测递归），可选附带回合端到端耗时（queueWaitMs、deliveryWaitMs、totalMs）与子任务拓扑。",
      parameters: Type.Object({
        hours: Type.Optional(Type.Integer({ minimum: 1, maximum: 720 })),
        thread: Type.Optional(Type.String({ pattern: THREAD_PATTERN })),
        model: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
        status: Type.Optional(STATUS_SCHEMA),
        purpose: Type.Optional(PURPOSE_SCHEMA),
        turnId: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
        includeCurrentTurn: Type.Optional(Type.Boolean({ description: "是否包含当前正在执行的本回合请求，默认 false。" })),
        includeTimings: Type.Optional(Type.Boolean({ description: "是否附带近期回合端到端排队/投递耗时，默认 false。" })),
        includeTopology: Type.Optional(Type.Boolean({ description: "是否附带活跃子 agent 拓扑，默认 false。" })),
        before: Type.Optional(Type.Integer({ minimum: 1 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
      }, { additionalProperties: false }),
      structuredOutputSchema: structuredSchema,
      replay: "safe",
      execute: (args, api, context) => guard("ops_requests", api, context, async () => {
        const now = Date.now(), hours = args.hours ?? 24, limit = args.limit ?? 20;
        const selfTurnId = !args.includeCurrentTurn && !args.turnId ? await deps.currentTurnId(api, context) : undefined;
        const store = deps.env.REQUESTS.getByName("main");
        const page = await store.list({
          since: now - hours * 3600_000,
          until: now,
          thread: args.thread,
          model: args.model,
          status: args.status,
          purpose: args.purpose,
          turnId: args.turnId,
          excludeTurnId: selfTurnId,
          before: args.before,
          limit,
        });
        const timings = args.includeTimings
          ? await store.recentTurns(args.thread, limit, selfTurnId)
          : undefined;
        const topology = args.includeTopology ? await store.agentTopology() : undefined;
        return {
          requests: page.requests,
          ...(page.next !== undefined ? { next: page.next } : {}),
          ...(selfTurnId ? { excludedTurnId: selfTurnId } : {}),
          ...(timings ? { timings } : {}),
          ...(topology ? { topology } : {}),
        };
      }),
    }),
    defineTool({
      name: "ops_inspect",
      description: "按 ID 查看单次模型请求（kind='request'）或单次工具调用轨迹（kind='tool'）。默认 summaryOnly=true 仅返回结构统计与摘要；非 owner 会话记录强制仅返回摘要。",
      parameters: Type.Object({
        kind: Type.Union([Type.Literal("request"), Type.Literal("tool")]),
        id: Type.String({ minLength: 1, maxLength: 80 }),
        summaryOnly: Type.Optional(Type.Boolean({ description: "默认 true 不展开完整提示词、消息或工具参数/结果正文；非 owner 会话强制为 true。" })),
      }, { additionalProperties: false }),
      structuredOutputSchema: structuredSchema,
      replay: "safe",
      execute: (args, api, context) => guard("ops_inspect", api, context, async () => {
        const store = deps.env.REQUESTS.getByName("main");
        const requestedSummary = args.summaryOnly ?? true;
        if (args.kind === "tool") {
          const head = await store.toolDetail(args.id, true);
          if (!head) return { found: false, kind: "tool", id: args.id };
          const crossThread = head.thread !== "owner";
          const metadataOnly = requestedSummary || crossThread;
          const tool = metadataOnly ? head : await store.toolDetail(args.id, false);
          return {
            found: true,
            kind: "tool",
            tool,
            ...(crossThread && !requestedSummary ? { crossThreadRedacted: true } : {}),
          };
        }
        const head = await store.detail(args.id, true);
        if (!head) return { found: false, kind: "request", id: args.id };
        const crossThread = head.request.thread !== "owner";
        const metadataOnly = requestedSummary || crossThread;
        const detail = metadataOnly ? head : (await store.detail(args.id, false)) ?? head;
        return {
          found: true,
          kind: "request",
          ...detail,
          ...(crossThread && !requestedSummary ? { crossThreadRedacted: true } : {}),
        };
      }),
    }),
    defineTool({
      name: "ops_logs",
      description: "查询实例环形异常/告警诊断日志（source='diag'，默认）或指定已知会话的审计事件日志（source='audit'，如 mcp_call、coding_exec、web_search、media_recall、runtime_ops）。",
      parameters: Type.Object({
        source: Type.Optional(Type.Union([Type.Literal("diag"), Type.Literal("audit")])),
        hours: Type.Optional(Type.Integer({ minimum: 1, maximum: 720 })),
        thread: Type.Optional(Type.String({ pattern: THREAD_PATTERN })),
        level: Type.Optional(Type.Union([Type.Literal("warn"), Type.Literal("error")])),
        event: Type.Optional(Type.String({ pattern: "^[a-z0-9_:-]{1,64}$", description: "diag 的 event 名或 audit 的 kind 名。" })),
        result: Type.Optional(Type.String({ pattern: "^[a-z0-9_:-]{1,64}$", description: "仅 source='audit' 时按 detail.result 过滤。" })),
        turnId: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
        before: Type.Optional(Type.Integer({ minimum: 1 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
      }, { additionalProperties: false }),
      structuredOutputSchema: structuredSchema,
      replay: "safe",
      execute: (args, api, context) => guard("ops_logs", api, context, async () => {
        const now = Date.now(), since = now - (args.hours ?? 24) * 3600_000, limit = args.limit ?? 20;
        if (args.source === "audit") {
          const target = args.thread ?? "owner";
          if (target !== "owner") {
            const known = (await deps.env.BRIDGE.getByName("napcat").threadList()).some(t => t.key === target);
            if (!known) return { source: "audit", thread: target, found: false, events: [] };
          }
          const page = await threadView(deps.env, target).events({
            since,
            kind: args.event,
            result: args.result,
            before: args.before,
            limit,
          }) as unknown as { events: { id: number; at: number; kind: string; detail: unknown }[]; next?: number };
          return {
            source: "audit",
            thread: target,
            found: true,
            events: page.events,
            ...(page.next !== undefined ? { next: page.next } : {}),
          };
        }
        const page = await deps.env.REQUESTS.getByName("main").queryLogs({
          since,
          level: args.level,
          event: args.event,
          thread: args.thread,
          turnId: args.turnId,
          before: args.before,
          limit,
        });
        return { source: "diag", ...page };
      }),
    }),
  ].map(tool => ({ ...tool, callers: ["tools"] as const }));

  return defineExtension({
    name: "cs.ops",
    tools: [healthTool, ...codemodeTools],
  });
}
