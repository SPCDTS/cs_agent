import { envApiKeyAuth, type Api, type Model, type Models, type ModelThinkingLevel, type ThinkingLevelMap } from "@earendil-works/pi-ai";
import { createProvider, type Provider } from "@earendil-works/pi-ai/models";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { log } from "../shared/log.js";

export interface MagpieCatalogEntry {
  id: string;
  display_name?: string;
  owned_by?: string;
  context_window?: number;
  max_output_tokens?: number;
  reasoning?: boolean;
  reasoning_levels?: string[];
  modalities?: { input?: string[] };
  native_endpoints?: string[];
}

type MagpieApi = "openai-completions" | "openai-responses";
// pi-ai 的 createProvider 接受完整 Model；网关地址在创建 provider 时统一补齐。
export type ProviderModel<TApi extends Api = MagpieApi> = Omit<Model<TApi>, "provider" | "baseUrl">;
const THINKING_LEVELS: ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function thinkingLevelMap(levels: string[] = []): ThinkingLevelMap {
  return Object.fromEntries(THINKING_LEVELS.map(level => [
    level, level === "off" && levels.includes("none") ? "none" : levels.includes(level) ? level : null,
  ]));
}

/** 保留 magpie 模型 ID；内置模型的兼容配置仍适用于网关转发。 */
export function magpieProviderModels(entries: MagpieCatalogEntry[], builtin: Models): ProviderModel<MagpieApi>[] {
  return entries.map(entry => {
    const modelId = entry.id.slice(entry.id.indexOf("/") + 1);
    const inherited = entry.owned_by ? builtin.getModel(entry.owned_by, modelId) : undefined;
    const contextWindow = entry.context_window ?? inherited?.contextWindow;
    const maxTokens = entry.max_output_tokens ?? inherited?.maxTokens;
    if (contextWindow === undefined || maxTokens === undefined) {
      log.warn("magpie model limits missing, using defaults", {
        model: entry.id, context_window: contextWindow ?? 128000, max_output_tokens: maxTokens ?? 32768,
      });
    }
    return {
      id: entry.id,
      name: entry.display_name ?? entry.id,
      api: entry.owned_by === "codex" && entry.native_endpoints?.includes("/v1/responses")
        ? "openai-responses" : "openai-completions",
      contextWindow: contextWindow ?? 128000,
      maxTokens: maxTokens ?? 32768,
      reasoning: entry.reasoning ?? inherited?.reasoning ?? false,
      input: inherited?.input ?? (entry.modalities?.input ?? ["text"]).filter((input): input is "text" | "image" => input === "text" || input === "image"),
      cost: inherited?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      thinkingLevelMap: inherited ? inherited.thinkingLevelMap : thinkingLevelMap(entry.reasoning_levels),
      compat: inherited?.compat as Model<MagpieApi>["compat"],
      promptCache: inherited?.promptCache,
      inputLimits: inherited?.inputLimits,
    };
  });
}

/** 目录只在启动时加载；错误信息不携带网关响应体。 */
export async function fetchMagpieCatalog(baseUrl: string, apiKey: string, fetchImpl: typeof fetch = fetch): Promise<MagpieCatalogEntry[]> {
  const response = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/models`, {
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`magpie 模型目录请求失败: HTTP ${response.status}`);
  // JSON 解析器的原始报错可能包含响应体片段，同样不向上暴露。
  const catalog: unknown = await response.json().catch(() => { throw new Error("magpie 模型目录不是有效 JSON"); });
  if (!catalog || typeof catalog !== "object" || !("data" in catalog) || !Array.isArray(catalog.data)) {
    throw new Error("magpie 模型目录缺少 data 数组");
  }
  // 条目缺少字符串 id 时跳过（避免启动时在映射阶段崩溃）。
  return catalog.data.filter((entry): entry is MagpieCatalogEntry => !!entry && typeof entry === "object" && typeof (entry as { id?: unknown }).id === "string");
}

export function createMagpieProvider(opts: { baseUrl: string; models: ProviderModel[] }): Provider<MagpieApi> {
  return createProvider({
    id: "magpie",
    name: "magpie",
    baseUrl: opts.baseUrl,
    auth: { apiKey: envApiKeyAuth("magpie gateway key", ["CODEX_MAGPIE_KEY"]) },
    models: opts.models.map(model => ({ ...model, provider: "magpie", baseUrl: opts.baseUrl })),
    api: {
      "openai-completions": openAICompletionsApi(),
      "openai-responses": openAIResponsesApi(),
    },
  });
}
