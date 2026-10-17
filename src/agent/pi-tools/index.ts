import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, hook, section, ToolTask, type Harness } from "@earendil-works/pi-durable";
import { parseAccess } from "../../context/access.js";
import type { ContextStore } from "../../context/store.js";
import { callQQContextTool } from "../../mcp/qq-context-server.js";
import { imageTool, type PiImageBackend } from "./images.js";
import { PiRequestDoc } from "./request.js";
import { PiPromptLoader } from "./prompt.js";
import { DeepSeekWeb } from "./web.js";

export interface PiToolsOptions {
  dataDir: string;
  store: ContextStore;
  imageBackend: PiImageBackend;
  getHarness: () => Harness;
  web?: DeepSeekWeb;
  maxContextChars?: number;
}

const output = (text: string) => ({ output: [{ type: "text" as const, text }] });

export function createPiExtension(opts: PiToolsOptions) {
  const web = opts.web ?? new DeepSeekWeb();
  const prompt = new PiPromptLoader(opts.dataDir);
  const history = (name: string, description: string, parameters: ReturnType<typeof Type.Object>) => defineTool({
    name, description, parameters, replay: "safe",
    async execute(args, api, context) {
      const request = await api.snapshot(PiRequestDoc, api.conversationId, context);
      const result = callQQContextTool({ access: parseAccess(request?.access), openStore: () => opts.store,
        maxChars: Math.min(2500, opts.maxContextChars ?? 2500) }, name, args);
      return { ...output(result.content.filter(c => c.type === "text").map(c => c.text).join("\n")), isError: result.isError === true };
    },
  });
  return defineExtension({
    name: "cs-pi",
    sections: [section("cs-pi", () => prompt.read(), { tag: false })],
    hooks: [
      hook(ToolTask, { beforeTool: async (call, api, context) => {
        const bound = await api.snapshot(PiRequestDoc, api.conversationId, context);
        if (!bound?.ticket || !parseAccess(bound.access)) return { block: "工具请求未绑定有效访问范围" };
        if (Date.now() >= bound.deadline) return { block: "pi 请求已超时" };
        const kind = call.name.startsWith("qq_") ? "history" : call.name;
        const limit = kind === "generate_image" ? 2 : 4;
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
        return allowed ? undefined : { block: `${call.name} 已达到本轮调用上限（${limit} 次）` };
      } }),
    ],
    tools: [
      defineTool({ name: "web_search", description: "搜索事实资料，返回标题、日期、摘要与来源链接。", replay: "safe",
        parameters: Type.Object({ query: Type.String({ minLength: 1, maxLength: 128 }), count: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })) }, { additionalProperties: false }),
        execute: async (args, _api, context) => output(await web.search(args.query, args.count, context.abortSignal)),
      }),
      defineTool({ name: "fetch_page", description: "读取公开 HTTP(S) 页面正文，最多 4000 字。", replay: "safe",
        parameters: Type.Object({ url: Type.String({ minLength: 1, maxLength: 2048 }) }, { additionalProperties: false }),
        execute: async (args, _api, context) => output(await web.page(args.url, context.abortSignal)),
      }),
      history("qq_recent", "按旧到新读取本次授权范围的最近记录；仅在追问或回顾时使用。", Type.Object({
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 30 })), before_message_id: Type.Optional(Type.String()),
      }, { additionalProperties: false })),
      history("qq_search", "关键词检索本次授权范围的消息与日周摘要，按时间倒序。", Type.Object({
        query: Type.String(), days: Type.Optional(Type.Integer({ minimum: 1, maximum: 180 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
      }, { additionalProperties: false })),
      history("qq_message", "读取本次授权范围的一条消息全文及最多三层引用链。", Type.Object({ message_id: Type.String() }, { additionalProperties: false })),
      imageTool(opts.dataDir, opts.imageBackend, opts.getHarness),
    ],
  });
}
