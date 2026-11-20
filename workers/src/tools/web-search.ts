import type { Api, AssistantMessage, Model, ProviderStreams, SimpleStreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
import { lazyStream } from "@earendil-works/pi-ai/api/lazy";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";

type SearchItem = { type: "web_search_call"; id: string; status?: string; action?: Record<string, unknown>;
  sources?: unknown; results?: unknown; page?: unknown; error?: unknown };
type SearchStep = { position: number; item: SearchItem; startedAt: number; endedAt: number };
type SearchMessage = AssistantMessage & { hostedSearch?: SearchStep[] };
export const hostedSearchSteps = (message: AssistantMessage) => (message as SearchMessage).hostedSearch ?? [];

// 只在主、子 agent 的生成请求中设置；不让压缩、后台提取或生图继承搜索。
export const agentSearchOption = { agentWebSearch: true } as const;
type SearchOptions = SimpleStreamOptions & { agentWebSearch?: boolean };

function replaySearch(context: TranscriptContext, model: Model<Api>): TranscriptContext {
  return normalizeContext({ messages: context.messages.map(message => {
    if (message.role !== "assistant" || message.provider !== model.provider || message.api !== model.api || message.model !== model.id) return message;
    const steps = hostedSearchSteps(message);
    if (!steps.length) return message;
    const content = [...message.content];
    // Responses 适配器会把签名块原样序列化为 input item。仅在传输副本里借用此入口，
    // 保留服务端结果、次序及签名；持久化历史中搜索与推理保持独立。
    for (const { position, item } of [...steps].reverse()) {
      content.splice(position, 0, { type: "thinking", thinking: "", thinkingSignature: JSON.stringify(item) });
    }
    return { ...message, content };
  }) });
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function withHostedSearch(regular: ProviderStreams, responses = regular): ProviderStreams {
  function send(method: "stream" | "streamSimple", model: Model<Api>, context: TranscriptContext, options?: SearchOptions) {
    if (!options?.agentWebSearch) return regular[method](model, context, options);
    const deepseek = model.provider === "deepseek";
    const flash = deepseek && model.id === "deepseek-flash";
    const type = flash ? "deepseek_web_search" : "web_search";
    const wireModel = deepseek ? { ...model, api: "openai-responses" } : model;
    const blocks = new Set<number>(), steps = new Map<number, SearchStep>(), starts = new Map<number, number>();
    const observe = (index: number, item: unknown, done: boolean) => {
      if (!object(item)) return;
      if (item.type !== "web_search_call") {
        if (["message", "reasoning", "function_call", "custom_tool_call"].includes(String(item.type))) blocks.add(index);
        return;
      }
      if (typeof item.id !== "string") return;
      if (!starts.has(index)) starts.set(index, Date.now());
      if (done && !steps.has(index)) steps.set(index, { item: item as SearchItem, position: 0, startedAt: starts.get(index)!, endedAt: Date.now() });
    };
    const stream = responses[method](wireModel, replaySearch(context, wireModel), { ...options,
      onPayload: async (original, m) => {
        const payload = await options?.onPayload?.(original, m) ?? original;
        if (!object(payload)) return payload;
        const tools = Array.isArray(payload.tools) ? payload.tools : [];
        // 旧会话的初始工具声明可能还包含已退役的同名函数。
        const current = tools.filter(t => !(t.type === "function" && t.name === "web_search") && t.type !== type);
        const reasoning = object(payload.reasoning) ? payload.reasoning : {};
        return { ...payload, tools: [...current, { type, ...(deepseek ? {} : { external_web_access: true }) }],
          ...(flash && (!reasoning.effort || reasoning.effort === "none") ? { reasoning: { ...reasoning, effort: "low" } } : {}) };
      },
      onProviderStreamEvent: async (event, m) => {
        if (object(event)) {
          if ((event.type === "response.output_item.added" || event.type === "response.output_item.done") && typeof event.output_index === "number")
            observe(event.output_index, event.item, event.type === "response.output_item.done");
          if (object(event.response) && Array.isArray(event.response.output) && ["response.completed", "response.done", "response.incomplete"].includes(String(event.type)))
            event.response.output.forEach((item: unknown, index: number) => observe(index, item, true));
        }
        await options?.onProviderStreamEvent?.(event, m);
      },
    });
    async function* events() {
      for await (const event of stream) {
        if ((event.type === "done" || event.type === "error") && steps.size) {
          const message: SearchMessage = event.type === "done" ? event.message : event.error;
          message.hostedSearch = [...steps].sort(([a], [b]) => a - b)
            .map(([index, step]) => ({ ...step, position: [...blocks].filter(block => block < index).length }));
        }
        yield event;
      }
    }
    return lazyStream(wireModel, async () => events());
  }
  return { stream: (m, c, o) => send("stream", m, c, o), streamSimple: (m, c, o) => send("streamSimple", m, c, o) };
}
