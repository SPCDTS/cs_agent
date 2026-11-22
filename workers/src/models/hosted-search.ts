import type { Api, AssistantMessage, Model, ProviderStreams, SimpleStreamOptions, SystemMessage, TranscriptContext } from "@earendil-works/pi-ai";
import { lazyStream } from "@earendil-works/pi-ai/api/lazy";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";

export type SearchItem = { type: "web_search_call"; id: string; status?: string; action?: Record<string, unknown>;
  sources?: unknown; results?: unknown; page?: unknown; error?: unknown };
export type SearchStep = { position: number; item: SearchItem; startedAt: number; endedAt: number };
export type SearchMessage = AssistantMessage & { hostedSearch?: SearchStep[] };
export const hostedSearchSteps = (message: AssistantMessage) => (message as SearchMessage).hostedSearch ?? [];

// 只在主、子 agent 的生成请求中设置；不让压缩、后台提取或生图继承搜索。
export const agentSearchOption = { agentWebSearch: true } as const;
export type SearchOptions = SimpleStreamOptions & { agentWebSearch?: boolean };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

// 当所有可恢复的会话都不再含旧版 web_search 函数声明时，可删除这层兼容。
export function withoutLegacySearch(message: SystemMessage): SystemMessage {
  return { ...message,
    ...(message.toolsAdded && { toolsAdded: message.toolsAdded.filter(tool => tool.name !== "web_search") }),
    ...(message.toolsRemoved && { toolsRemoved: message.toolsRemoved.filter(tool => tool.name !== "web_search") }),
  };
}

export function stripLegacySearchContext(context: TranscriptContext): TranscriptContext {
  return normalizeContext({ messages: context.messages.map(message =>
    message.role === "system" ? withoutLegacySearch(message) : message) });
}

function replayResponsesSearch(context: TranscriptContext, model: Model<Api>): TranscriptContext {
  return normalizeContext({ messages: context.messages.map(message => {
    if (message.role === "system") return withoutLegacySearch(message);
    if (message.role !== "assistant" || message.provider !== model.provider || message.api !== model.api || message.model !== model.id) return message;
    const steps = hostedSearchSteps(message).filter(step => step.item.status === "completed");
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

export type ResponsesSearchAdapter = {
  wireModel?(model: Model<Api>): Model<Api>;
  patchPayload(payload: Record<string, unknown>, model: Model<Api>): Record<string, unknown>;
};

const DEFAULT_RESPONSES_ADAPTER: ResponsesSearchAdapter = {
  patchPayload(payload) {
    const tools = Array.isArray(payload.tools) ? payload.tools.filter(t => !isRecord(t) || t.type !== "web_search") : [];
    return { ...payload, tools: [...tools, { type: "web_search", external_web_access: true }] };
  },
};

/** 兼容 OpenAI Responses SSE 的服务端搜索包装器；各供应商差异由 adapter 传入，不在公共层写分支。 */
export function withResponsesSearch(regular: ProviderStreams, responses = regular, adapter: ResponsesSearchAdapter = DEFAULT_RESPONSES_ADAPTER): ProviderStreams {
  function send(method: "stream" | "streamSimple", model: Model<Api>, context: TranscriptContext, options?: SearchOptions) {
    if (!options?.agentWebSearch) return regular[method](model, context, options);
    const wireModel = adapter.wireModel ? adapter.wireModel(model) : model;
    const blocks = new Set<number>();
    const steps = new Map<number, { item: SearchItem; startedAt: number; endedAt?: number }>();
    const observe = (index: number, item: unknown, done: boolean) => {
      if (!isRecord(item)) return;
      if (item.type !== "web_search_call") {
        if (["message", "reasoning", "function_call", "custom_tool_call"].includes(String(item.type))) blocks.add(index);
        return;
      }
      if (typeof item.id !== "string") return;
      const previous = steps.get(index), now = Date.now();
      const search = item as SearchItem;
      // 终态响应有时才补齐来源；同一调用的完成时间仍取首次 done。
      const merged = { ...previous?.item, ...search,
        ...(search.action && { action: { ...previous?.item.action, ...search.action } }) };
      steps.set(index, { item: merged, startedAt: previous?.startedAt ?? now, endedAt: previous?.endedAt ?? (done ? now : undefined) });
    };
    const stream = responses[method](wireModel, replayResponsesSearch(context, wireModel), { ...options,
      onPayload: async (original, m) => {
        const payload = await options?.onPayload?.(original, m) ?? original;
        return isRecord(payload) ? adapter.patchPayload(payload, m) : payload;
      },
      onProviderStreamEvent: async (event, m) => {
        if (isRecord(event)) {
          if ((event.type === "response.output_item.added" || event.type === "response.output_item.done") && typeof event.output_index === "number")
            observe(event.output_index, event.item, event.type === "response.output_item.done");
          if (isRecord(event.response) && Array.isArray(event.response.output) && ["response.completed", "response.done", "response.incomplete"].includes(String(event.type)))
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
            .map(([index, step]) => ({ ...step, endedAt: step.endedAt ?? Date.now(), position: [...blocks].filter(block => block < index).length }));
        }
        yield event;
      }
    }
    return lazyStream(wireModel, async () => events());
  }
  return { stream: (m, c, o) => send("stream", m, c, o), streamSimple: (m, c, o) => send("streamSimple", m, c, o) };
}
