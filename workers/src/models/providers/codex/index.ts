import type { Api, Credential, Model, ProviderStreams } from "@earendil-works/pi-ai";
import { createProvider, type Provider } from "@earendil-works/pi-ai/models";
import { openAICodexResponsesApi } from "@earendil-works/pi-ai/api/openai-codex-responses.lazy";
import { OPENAI_CODEX_MODELS } from "@earendil-works/pi-ai/providers/openai-codex.models";
import { withResponsesSearch } from "../../hosted-search";
import type { ProviderOptions, ProviderSpec } from "../../types";
import { codexFetch } from "./fetch";
import { CODEX_BASE_URL, CODEX_PROVIDER, accountCodexCatalog, codexOAuth, type CodexCatalogEntry } from "./login";

export * from "./login";
export * from "./accounts";
export * from "./errors";
export * from "./fetch";

export type CodexModels = readonly Model<Api>[];

const builtins = new Map<string, Model<"openai-codex-responses">>(Object.values(OPENAI_CODEX_MODELS).map(model => [model.id, model]));

export function codexModel(meta: CodexCatalogEntry): Model<"openai-codex-responses"> {
  const known = builtins.get(meta.slug);
  const efforts = meta.supported_reasoning_levels?.map(level => level.effort);
  const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
  const thinkingLevelMap = efforts ? Object.fromEntries(levels.map(level => {
    const wire = level === "off" ? "none" : level;
    return [level, efforts.includes(wire) ? wire : level === "minimal" && efforts.includes("low") ? "low" : null];
  })) : known?.thinkingLevelMap;
  return { ...known, id: meta.slug, name: meta.display_name, provider: CODEX_PROVIDER, api: "openai-codex-responses", baseUrl: CODEX_BASE_URL,
    input: meta.input_modalities?.length ? meta.input_modalities : known?.input ?? ["text"],
    reasoning: efforts ? efforts.some(effort => effort !== "none") : known?.reasoning ?? false, thinkingLevelMap,
    contextWindow: meta.context_window ?? known?.contextWindow ?? 16_384,
    // 未报告输出上限时仅用作本地预算。Codex 协议不发送 max_output_tokens。
    maxTokens: meta.max_output_tokens ?? known?.maxTokens ?? 4_096,
    cost: known?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: { ...known?.compat, supportsMidConvoEffort: false, supportsLongCacheRetention: false,
      supportsExplicitPromptCacheMode: false, supportsMaxOutputTokens: false } };
}

function createCodexProvider({ fetch, catalogs }: ProviderOptions = {}): Provider {
  const native = withResponsesSearch(openAICodexResponsesApi());
  const transport: ProviderStreams = {
    stream: (model, context, options) => native.stream({ ...model, api: "openai-codex-responses" }, context, { ...options, fetch: codexFetch(fetch ?? options?.fetch ?? globalThis.fetch) }),
    streamSimple: (model, context, options) => native.streamSimple({ ...model, api: "openai-codex-responses" }, context, { ...options, fetch: codexFetch(fetch ?? options?.fetch ?? globalThis.fetch) }),
  };
  const provider = createProvider({ id: CODEX_PROVIDER, name: "ChatGPT 订阅", baseUrl: CODEX_BASE_URL,
    auth: { oauth: codexOAuth }, models: [], api: transport });
  const current = () => catalogs?.()[CODEX_PROVIDER] ?? [];
  const available = (_models: readonly unknown[], credential: Credential | undefined) => accountCodexCatalog(credential).map(codexModel);
  return { ...provider, getModels: current, getAllModels: current, filterModels: available, filterAllModels: available };
}

export const CODEX_SPEC: ProviderSpec = {
  name: "ChatGPT 订阅",
  listed: () => true,
  create: createCodexProvider,
  unavailable: "login_required",
  dynamicCatalog: true,
  credentialScopedModels: true,
};
