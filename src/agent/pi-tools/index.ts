import { isScheduleTool } from "../../shared/schedule-tools.js";
import type { ScheduleTools } from "../schedule/tools.js";
import type { GrantsService } from "../grants.js";
import type { Channel } from "../../channel/types.js";
import { chatsTool } from "./chats.js";
import path from "node:path";
import { QQ_LINK_RULE, SEND_RULE, type SendService } from "../send-service.js";
import { type AttachmentLimits } from "../../media/attach.js";
import type { RecallObserver } from "../../context/observer.js";
import { BUILTIN_TOOLS, PiExecutionEnv } from "./coding.js";
import { redactText } from "../../shared/redact.js";
import { recallTool } from "./recall.js";
import type { MediaRecall } from "../../context/media.js";
import { RECALL_QUOTA_MESSAGE } from "../../context/media-recall-server.js";
import { usageFields } from "../../shared/usage.js";
import { classifyFailure, diagnosticFailure, type Failure } from "../../shared/errors.js";
import { trace } from "../../shared/trace.js";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, hook, section, ToolTask, GenerationTask, CompactionTask, type Harness } from "@earendil-works/pi-durable";
import { parseAccess } from "../../context/access.js";
import type { ContextStore } from "../../context/store.js";
import { callQQContextTool } from "../../context/qq-context-tool.js";
import { imageTool, type PiImageBackend } from "./images.js";
import { PiRequestDoc } from "./request.js";
import { PiPromptLoader } from "./prompt.js";
import { ProjectContextLoader } from "./project-context.js";
import { SkillsLoader } from "./skills.js";
import { DeepSeekWeb } from "./web.js";

export const PI_WORKSPACE_RULE = "当前目录就是你的工作区，文件跨回合保留。普通文件一律用相对路径写在这里，不要尝试其他目录。bash 的 /tmp 每条命令结束即清空，文件工具也不能写入 /tmp；图片工具和有权限的技能操作使用各自指定的目录。";

export interface PiToolsOptions {
  sendService?: SendService;
  grants?: GrantsService;
  scheduleTools?: ScheduleTools;
  dataDir: string;
  workspaceDir: string;
  /** 空值或未设置使用 dataDir/skills；off 禁用技能目录。 */
  skillsDir?: string;
  store: ContextStore;
  imageBackend: PiImageBackend;
  getHarness: () => Harness;
  web?: DeepSeekWeb;
  maxContextChars?: number;
  attachmentLimits?: AttachmentLimits;
  instrumentation?: RecallObserver;
  channel?: Pick<Channel, "listChats">;
  mediaRecall?: Pick<MediaRecall, "recall">;
  mediaRecallMaxPerTicket?: number;
}

const builtinSummary = (call: { name: string; arguments: Record<string, unknown> }) => ({
  backend: "pi", tool: call.name,
  ...(call.name === "bash" ? { command: redactText(String(call.arguments.command ?? ""), 200) }
    : { path: redactText(String(call.arguments.path ?? ""), 200) }),
});
const output = (text: string) => ({ output: [{ type: "text" as const, text }] });

export function createPiExtension(opts: PiToolsOptions) {
  const failures = new Map<number, Failure>();
  const boundary = async <T>(id: number, provider: string, run: () => Promise<T>): Promise<T> => {
    try { return await run(); } catch (error) {
      if (failures.size >= 2048) failures.delete(failures.keys().next().value!);
      failures.set(id,classifyFailure(error,provider)); throw error;
    }
  };
  const started = new Map<number, number>();
  const start = (id: number) => {
    if (started.size >= 2048) started.delete(started.keys().next().value!);
    started.set(id, Date.now());
  };
  const recall = recallTool(opts.mediaRecall);
  const image = imageTool(opts.dataDir, opts.imageBackend, opts.getHarness, opts.store);
  const web = opts.web ?? new DeepSeekWeb();
  const prompt = new PiPromptLoader(opts.dataDir);
  const projectContext = new ProjectContextLoader(opts);
  const skills = opts.skillsDir === "off" ? undefined : new SkillsLoader({ dir: opts.skillsDir || path.join(opts.dataDir, "skills") });
  const history = (name: string, description: string, parameters: ReturnType<typeof Type.Object>) => defineTool({
    name, description, parameters, replay: "safe",
    async execute(args, api, context) {
      return boundary(api.taskId,"qq_context",async () => {
      const bound = await api.snapshot(PiRequestDoc, api.conversationId, context);
      const result = callQQContextTool({ access: parseAccess(bound?.access), openStore: () => opts.store,
        maxChars: Math.min(2500, opts.maxContextChars ?? 2500), onRecall: event => {
          const attribution = { backend: 'pi', ticket: bound?.ticket, session: String(api.conversationId), task_id: String(api.taskId) };
          const id = opts.instrumentation?.recordRecall({ ...event, ...attribution });
          trace.event(bound?.ticket || '@pi', 'memory_recall', { status: event.is_error ? 'failed' : 'ok', durationMs: event.duration_ms,
            detail: { ...attribution, recall_id: id, tool: event.tool, returned_count: event.returned_count,
              dropped_count: event.dropped_count, chars: event.chars, max_chars: event.max_chars } });
        } }, name, args);
      return { ...output(result.content.filter(c => c.type === "text").map(c => c.text).join("\n")), isError: result.isError === true };
      });
    },
  });
  return defineExtension({
    name: "cs-pi",
    sections: [
      section("cs-pi", async () => SEND_RULE + "\n" + QQ_LINK_RULE + "\n" + PI_WORKSPACE_RULE + "\n\n" + await prompt.read(), { tag: false }),
      section("project-context", input => projectContext.render(input.env?.cwd), { tag: false }),
      section("skills", input => skills?.render(input.env instanceof PiExecutionEnv && input.env.policy.options.request.senderIsOwner === true), { tag: false }),
    ],
    hooks: [
      hook(CompactionTask, { beforeCompact: async (compact, api, context) => {
        const bound = await api.snapshot(PiRequestDoc, api.conversationId, context);
        trace.event(bound?.ticket || "@pi", "compaction", { detail: { conversation: api.conversationId, reason: compact.reason, entries: compact.entries.length } });
      } }),
      hook(GenerationTask, {
        beforeRequest: async (_request, api, context) => {
          const bound = await api.snapshot(PiRequestDoc, api.conversationId, context);
          start(api.taskId);
          if (bound?.ticket) trace.event(bound.ticket, "model_turn", { status: "started", detail: { backend: "pi", conversation: api.conversationId } });
        },
        afterResponse: async (message, api, context) => {
          const bound = await api.snapshot(PiRequestDoc, api.conversationId, context);
          if (bound?.ticket) trace.event(bound.ticket, "model_turn", { status: ["error", "aborted"].includes(message.stopReason) ? "failed" : "ok",
            durationMs: started.has(api.taskId) ? Date.now() - started.get(api.taskId)! : undefined,
            detail: { backend: "pi", provider: message.provider, model: message.model, ...usageFields(message.usage), failure: message.stopReason === "error" ? classifyFailure(message.errorMessage,message.provider) : undefined,
              error: message.errorMessage, reply: message.content.filter(c => c.type === "text").map(c => c.text).join("") } });
          started.delete(api.taskId);
        },
      }),
      hook(ToolTask, { beforeTool: async (call, api, context) => {
        const bound = await api.snapshot(PiRequestDoc, api.conversationId, context);
        if (!bound?.ticket || !parseAccess(bound.access)) return { block: "工具请求未绑定有效访问范围" };
        start(api.taskId);
        trace.event(bound.ticket, "tool:" + call.name, { status: "started", detail: BUILTIN_TOOLS.has(call.name) ? builtinSummary(call) : { backend: "pi", input: call.arguments } });
        const block = (reason: string) => {
          trace.event(bound.ticket, "tool:" + call.name, { status: "failed", durationMs: Date.now() - started.get(api.taskId)!, detail: { backend: "pi", error: reason } });
          started.delete(api.taskId);
          return { block: reason };
        };
        if (Date.now() >= bound.deadline) return block("pi 请求已超时");
        // send_message 由 Outbox 限额，重放不额外计次，也不消耗聊天记录工具额度。
        if (call.name.startsWith("auth_")) return bound.actorIsOwner ? undefined : block("授权工具仅限 owner 回合");
        // 定时工具由共用服务逐次鉴权与限额，不套用历史查询的每轮四次上限。
        if (call.name === "send_message" || isScheduleTool(call.name)) return undefined;
        const kind = BUILTIN_TOOLS.has(call.name) ? "builtin" : call.name === "qq_image" ? "qq_image" : call.name.startsWith("qq_") ? "history" : call.name;
        const limit = kind === "builtin" ? 20 : kind === "qq_image" ? opts.mediaRecallMaxPerTicket ?? 5 : kind === "generate_image" ? 2 : 4;
        const allowed = await opts.getHarness().commit(async tx => {
          const doc = await tx.doc(PiRequestDoc, api.conversationId);
          if (doc.ticket !== bound.ticket) return false;
          if (doc.calls[String(api.taskId)]) return true;
          const pending = kind === "generate_image" ? doc.imageJobs?.find(j => j.status !== "done") : undefined;
          if (pending) { doc.calls[String(api.taskId)] = { kind, ordinal: pending.ordinal }; return true; }
          const used = new Set(Object.values(doc.calls).filter(c => c.kind === kind).map(c => c.ordinal)).size;
          if (used >= limit) return false;
          doc.calls[String(api.taskId)] = { kind, ordinal: used + 1 };
          return true;
        }, context);
        return allowed ? undefined : block(kind === "qq_image" ? RECALL_QUOTA_MESSAGE : `${call.name} 已达到本轮调用上限（${limit} 次）`);
      }, afterTool: async (call, result, api, context) => {
        const bound = await api.snapshot(PiRequestDoc, api.conversationId, context);
        const structured = result.structuredOutput;
        const exitCode = structured && typeof structured === "object" && !Array.isArray(structured) ? structured.exitCode : undefined;
        if (bound?.ticket) trace.event(bound.ticket, "tool:" + call.name, { status: result.isError ? "failed" : "ok",
          durationMs: started.has(api.taskId) ? Date.now() - started.get(api.taskId)! : undefined,
          detail: BUILTIN_TOOLS.has(call.name) ? { ...builtinSummary(call),
            exit_code: typeof exitCode === "number" ? exitCode : null,
            failure: result.isError ? diagnosticFailure(result, "local") : undefined,
          } : { backend: "pi", failure: result.isError ? failures.get(api.taskId) ?? diagnosticFailure(result, call.name === "generate_image" ? "comfy" : call.name === "qq_image" ? "media_recall" : call.name.startsWith("qq_") ? "qq_context" : "deepseek") : undefined, output: result, error: result.isError ? result.output?.map(c => c.type === "text" ? c.text : "").join("\n") : undefined } });
        failures.delete(api.taskId);
        started.delete(api.taskId);
        return undefined;
      } }),
    ],
    tools: [
      chatsTool(opts.channel),
      defineTool({ ...recall, execute: (args, api, context) => boundary(api.taskId,"media_recall",async () => recall.execute(args,api,context)) }),
      defineTool({ name: "web_search", description: "搜索事实资料，返回标题、日期、摘要与来源链接。", replay: "safe",
        parameters: Type.Object({ query: Type.String({ minLength: 1, maxLength: 128 }), count: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })) }, { additionalProperties: false }),
        execute: async (args, api, context) => boundary(api.taskId,"deepseek",async () => output(await web.search(args.query, args.count, context.abortSignal))),
      }),
      defineTool({ name: "fetch_page", description: "读取公开 HTTP(S) 页面正文，最多 4000 字。", replay: "safe",
        parameters: Type.Object({ url: Type.String({ minLength: 1, maxLength: 2048 }) }, { additionalProperties: false }),
        execute: async (args, api, context) => boundary(api.taskId,"deepseek",async () => output(await web.page(args.url, context.abortSignal))),
      }),
      history("qq_recent", "按旧到新读取本次授权范围的最近记录；仅在追问或回顾时使用。", Type.Object({
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 30 })), before_message_id: Type.Optional(Type.String()),
      }, { additionalProperties: false })),
      history("qq_search", "关键词检索本次授权范围的消息与日周摘要，按时间倒序。", Type.Object({
        query: Type.String(), days: Type.Optional(Type.Integer({ minimum: 1, maximum: 180 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
      }, { additionalProperties: false })),
      history("qq_message", "读取本次授权范围的一条消息全文及最多三层引用链。", Type.Object({ message_id: Type.String() }, { additionalProperties: false })),
      defineTool({ ...image, execute: (args, api, context) => boundary(api.taskId,"comfy",async () => image.execute(args,api,context)) }),
    ],
  });
}
