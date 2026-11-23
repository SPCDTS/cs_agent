import type { Api, Model, ProviderStreams, TranscriptContext } from "@earendil-works/pi-ai";
import type { Provider } from "@earendil-works/pi-ai/models";
import { lazyStream } from "@earendil-works/pi-ai/api/lazy";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { GOOGLE_MODELS } from "@earendil-works/pi-ai/providers/google.models";
import { isRecord, stripLegacySearchContext, type SearchItem, type SearchMessage, type SearchOptions } from "../hosted-search";
import type { ProviderSpec } from "../types";

export const GOOGLE_PROVIDER = "google";

const GOOGLE_EXTRA_MODELS: readonly { id: string; name: string; maxTokens: number }[] = [
  { id: "gemini-4-carbon", name: "Gemini 4 Carbon", maxTokens: 32_768 },
  { id: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen", maxTokens: 65_536 },
  { id: "gemini-4-neon", name: "Gemini 4 Neon", maxTokens: 65_536 },
];

// 跨供应商或跨模型续轮无原生 thoughtSignature 时，按 @google/genai 规范原样填入跳过校验哨兵字面量。
export const SKIP_THOUGHT_SIGNATURE = "skip_thought_signature_validator";

function geminiModels(): readonly Model<"google-generative-ai">[] {
  // 排除新账号已下线的 2.5 系列及非标准文本工具对话的专用端点。
  const base = GOOGLE_MODELS["gemini-4-argon"];
  const builtin = Object.values(GOOGLE_MODELS).filter(model =>
    !model.id.startsWith("gemini-2.5-") && !model.id.startsWith("deep-research-")
    && !model.id.endsWith("-image") && !model.id.includes("-live"))
    .map(model => model.id === "gemini-flash-latest" && base ? { ...model, thinkingLevelMap: base.thinkingLevelMap } : model);
  const known = new Set<string>(builtin.map(model => model.id));
  const extra = base ? GOOGLE_EXTRA_MODELS.filter(entry => !known.has(entry.id)).map(entry => ({ ...base, ...entry })) : [];
  return [...builtin, ...extra];
}

function normalizeGoogleContents(contents: unknown): unknown {
  if (!Array.isArray(contents)) return contents;
  let mutated = false;
  const next = contents.map((entry: unknown) => {
    if (!isRecord(entry) || entry.role !== "model" || !Array.isArray(entry.parts)) return entry;
    const hasSignature = entry.parts.some((p: unknown) => isRecord(p) && typeof p.thoughtSignature === "string" && p.thoughtSignature.length > 0);
    if (hasSignature) return entry;
    const idx = entry.parts.findIndex((p: unknown) => isRecord(p) && isRecord(p.functionCall));
    if (idx < 0) return entry;
    mutated = true;
    const parts = entry.parts.map((p: unknown, i: number) => i === idx && isRecord(p) ? { ...p, thoughtSignature: SKIP_THOUGHT_SIGNATURE } : p);
    return { ...entry, parts };
  });
  return mutated ? next : contents;
}

function normalizeGooglePayload(payload: unknown, model: Model<Api>, enableSearch: boolean): unknown {
  if (!isRecord(payload)) return payload;
  const contents = normalizeGoogleContents(payload.contents);
  const rawConfig = isRecord(payload.config) ? payload.config : undefined;
  const dropZeroBudget = isRecord(rawConfig?.thinkingConfig) && rawConfig.thinkingConfig.thinkingBudget === 0 && model.id.includes("-pro");
  if (!enableSearch && contents === payload.contents && !dropZeroBudget) return payload;
  const config = { ...(rawConfig ?? {}) };
  if (dropZeroBudget) delete config.thinkingConfig;
  if (enableSearch) {
    const tools = Array.isArray(config.tools) ? config.tools.filter(t => !isRecord(t) || !("googleSearch" in t)) : [];
    const toolConfig = isRecord(config.toolConfig) ? config.toolConfig : {};
    config.tools = [...tools, { googleSearch: {} }];
    config.toolConfig = { ...toolConfig, includeServerSideToolInvocations: true };
  }
  return {
    ...payload,
    ...(contents !== payload.contents ? { contents } : {}),
    ...(enableSearch || dropZeroBudget || rawConfig ? { config } : {}),
  };
}

/** Gemini 原生搜索注入 googleSearch 并显式开启服务端工具调用回传；异源无签名工具调用自动补齐官方跳过哨兵。 */
export function withGoogleSearch(regular: ProviderStreams): ProviderStreams {
  function send(method: "stream" | "streamSimple", model: Model<Api>, context: TranscriptContext, options?: SearchOptions) {
    const cleanContext = stripLegacySearchContext(context);
    if (!options?.agentWebSearch) {
      return regular[method](model, cleanContext, {
        ...options,
        onPayload: async (original, m) => normalizeGooglePayload(await options?.onPayload?.(original, m) ?? original, m, false),
      });
    }
    const steps = new Map<string, { item: SearchItem; startedAt: number; endedAt?: number; position: number }>();
    let fallbackQueries: string[] = [];
    let sources: { url: string; title?: string }[] = [];
    let firstAt = Date.now(), lastAt = firstAt;
    const stream = regular[method](model, cleanContext, { ...options,
      onPayload: async (original, m) => normalizeGooglePayload(await options?.onPayload?.(original, m) ?? original, m, true),
      onProviderStreamEvent: async (event, m) => {
        const candidate = isRecord(event) && Array.isArray(event.candidates) && isRecord(event.candidates[0]) ? event.candidates[0] : undefined;
        if (candidate) {
          const now = Date.now();
          lastAt = now;
          const parts = isRecord(candidate.content) && Array.isArray(candidate.content.parts) ? candidate.content.parts : [];
          for (const part of parts) {
            if (!isRecord(part)) continue;
            if (isRecord(part.toolCall) && String(part.toolCall.toolType ?? "").startsWith("GOOGLE_SEARCH")) {
              const id = typeof part.toolCall.id === "string" ? part.toolCall.id : `gs_${steps.size}`;
              const args = isRecord(part.toolCall.args) ? part.toolCall.args : {};
              const queries = Array.isArray(args.queries) ? args.queries.filter((q): q is string => typeof q === "string") : undefined;
              const prev = steps.get(id);
              steps.set(id, { startedAt: prev?.startedAt ?? now, endedAt: prev?.endedAt, position: prev?.position ?? 0,
                item: { type: "web_search_call", id, status: prev?.item.status ?? "in_progress",
                  action: { type: "search", ...args, ...(queries?.length ? { query: queries.join(" / ") } : {}) } } });
            } else if (isRecord(part.toolResponse) && String(part.toolResponse.toolType ?? "").startsWith("GOOGLE_SEARCH")) {
              const id = typeof part.toolResponse.id === "string" ? part.toolResponse.id : [...steps.keys()].findLast(k => !steps.get(k)?.endedAt);
              const prev = id ? steps.get(id) : undefined;
              if (id && prev) steps.set(id, { ...prev, endedAt: prev.endedAt ?? now, item: { ...prev.item, status: "completed" } });
            }
          }
          const grounding = isRecord(candidate.groundingMetadata) ? candidate.groundingMetadata : undefined;
          if (grounding) {
            if (Array.isArray(grounding.webSearchQueries)) {
              const qs = grounding.webSearchQueries.filter((q): q is string => typeof q === "string" && q.length > 0);
              if (qs.length) { if (!fallbackQueries.length) firstAt = now; fallbackQueries = qs; }
            }
            if (Array.isArray(grounding.groundingChunks)) {
              const next = grounding.groundingChunks.flatMap((c: unknown) => isRecord(c) && isRecord(c.web) && typeof c.web.uri === "string"
                ? [{ url: c.web.uri, ...(typeof c.web.title === "string" ? { title: c.web.title } : {}) }] : []);
              if (next.length) sources = next;
            }
          }
        }
        await options?.onProviderStreamEvent?.(event, m);
      },
    });
    async function* events() {
      for await (const event of stream) {
        if (event.type === "done" || event.type === "error") {
          if (!steps.size && fallbackQueries.length) {
            steps.set("gs_0", { startedAt: firstAt, endedAt: lastAt, position: 0,
              item: { type: "web_search_call", id: "gs_0", status: "completed",
                action: { type: "search", query: fallbackQueries.join(" / "), queries: fallbackQueries } } });
          }
          if (steps.size) {
            const message: SearchMessage = event.type === "done" ? event.message : event.error;
            message.hostedSearch = [...steps.values()].map(step => ({ ...step, endedAt: step.endedAt ?? Date.now(),
              item: sources.length ? { ...step.item, sources } : step.item }));
          }
        }
        yield event;
      }
    }
    return lazyStream(model, async () => events());
  }
  return { stream: (m, c, o) => send("stream", m, c, o), streamSimple: (m, c, o) => send("streamSimple", m, c, o) };
}

function createGoogleProvider(): Provider {
  // Google 适配器不允许传入自定义 fetch（拒绝 ModelAlarm.fetch），直连公开端点即可。
  const provider = googleProvider();
  const catalog = geminiModels();
  return { ...provider, getModels: () => catalog, getAllModels: () => catalog, ...withGoogleSearch(provider) };
}

export const GOOGLE_SPEC: ProviderSpec = {
  name: "Gemini",
  listed: () => true,
  create: createGoogleProvider,
  unavailable: "missing_gemini_key",
  secretName: "GEMINI_API_KEY",
};
