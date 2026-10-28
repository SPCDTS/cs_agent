import { envApiKeyAuth, Type, type Static, type Api, type Model, type Models, type ModelThinkingLevel, type ThinkingLevelMap } from "@earendil-works/pi-ai";
import { Check } from "typebox/value";
import { createProvider, type Provider } from "@earendil-works/pi-ai/models";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";

const CatalogEntry = Type.Object({
  id: Type.String({ minLength: 1 }),
  display_name: Type.Optional(Type.String()), owned_by: Type.Optional(Type.String()),
  context_window: Type.Optional(Type.Integer({ minimum: 1 })),
  max_output_tokens: Type.Optional(Type.Integer({ minimum: 1 })),
  reasoning: Type.Optional(Type.Boolean()), reasoning_levels: Type.Optional(Type.Array(Type.String())),
  modalities: Type.Optional(Type.Object({ input: Type.Optional(Type.Array(Type.String())) })),
  native_endpoints: Type.Optional(Type.Array(Type.String())),
});
export type MagpieCatalogEntry = Static<typeof CatalogEntry>;
type MagpieApi = "openai-completions" | "openai-responses";
export type ProviderModel<TApi extends Api = MagpieApi> = Omit<Model<TApi>, "provider" | "baseUrl">;
const THINKING_LEVELS: ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function thinkingLevelMap(levels: string[] = []): ThinkingLevelMap {
  return Object.fromEntries(THINKING_LEVELS.map(level => [
    level, level === "off" && levels.includes("none") ? "none" : levels.includes(level) ? level : null,
  ]));
}

export function magpieProviderModels(entries: MagpieCatalogEntry[], builtin: Models): ProviderModel[] {
  return entries.map(entry => {
    const modelId = entry.id.slice(entry.id.indexOf("/") + 1);
    const inherited = entry.owned_by ? builtin.getModel(entry.owned_by, modelId) : undefined;
    return {
      id: entry.id, name: entry.display_name ?? entry.id,
      api: entry.owned_by === "codex" && entry.native_endpoints?.includes("/v1/responses") ? "openai-responses" : "openai-completions",
      contextWindow: entry.context_window ?? inherited?.contextWindow ?? 128000,
      maxTokens: entry.max_output_tokens ?? inherited?.maxTokens ?? 32768,
      reasoning: entry.reasoning ?? inherited?.reasoning ?? false,
      input: inherited?.input ?? (entry.modalities?.input ?? ["text"]).filter((input): input is "text" | "image" => input === "text" || input === "image"),
      cost: inherited?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      thinkingLevelMap: inherited?.thinkingLevelMap ?? thinkingLevelMap(entry.reasoning_levels),
      // 只有同类 API 的兼容选项才能转交给对应的 OpenAI 适配器。
      compat: inherited?.api === "openai-completions" || inherited?.api === "openai-responses" ? inherited.compat : undefined,
      promptCache: inherited?.promptCache, inputLimits: inherited?.inputLimits,
    };
  });
}

export async function fetchMagpieCatalog(baseUrl: string, apiKey: string, fetchImpl: typeof fetch = fetch): Promise<MagpieCatalogEntry[]> {
  const response = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(30_000), redirect: "error",
  });
  if (!response.ok) throw new Error(`magpie 模型目录请求失败: HTTP ${response.status}`);
  // 原始 JSON 解析错误可能带响应片段，不能把网关正文传到日志或健康检查。
  const catalog: unknown = await response.json().catch(() => { throw new Error("magpie 模型目录不是有效 JSON"); });
  if (!Check(Type.Object({ data: Type.Array(Type.Unknown()) }), catalog)) throw new Error("magpie 模型目录缺少 data 数组");
  return catalog.data.filter((entry): entry is MagpieCatalogEntry => Check(CatalogEntry, entry));
}

export function createMagpieProvider(opts: { baseUrl: string; models: ProviderModel[] }): Provider<MagpieApi> {
  return createProvider({
    id: "magpie", name: "magpie", baseUrl: opts.baseUrl,
    auth: { apiKey: envApiKeyAuth("magpie gateway key", ["MAGPIE_GATEWAY_KEY"]) },
    models: opts.models.map(model => ({ ...model, provider: "magpie", baseUrl: opts.baseUrl })),
    api: { "openai-completions": openAICompletionsApi(), "openai-responses": openAIResponsesApi() },
  });
}
