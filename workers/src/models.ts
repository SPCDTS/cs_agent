import { createModels, createProvider, type Models, type MutableModels, type Provider } from "@earendil-works/pi-ai/models";
import type { CredentialStore, ProviderStreams } from "@earendil-works/pi-ai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { openAICodexResponsesApi } from "@earendil-works/pi-ai/api/openai-codex-responses.lazy";
import { OPENAI_CODEX_MODELS } from "@earendil-works/pi-ai/providers/openai-codex.models";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import type { Env } from "./env";
import { withHostedSearch } from "./tools/web-search";
import { codexFetch } from "./codex-fetch";
import { CODEX_BASE_URL, CODEX_PROVIDER, codexOAuth, isChatGPTCredential } from "./codex-login";
import { FAUX_PROVIDER } from "./models-faux";
import type { ModelSelection } from "./settings";

export type ProviderSpec = {
  /** 面板显示名 */
  name: string;
  /** 不列出的 provider 也不能被选中；faux 只在测试配置里出现。 */
  listed(env: Env): boolean;
  create(options?: { fetch?: typeof fetch }): Provider;
  /** checkAuth 不通过时给面板与健康检查的原因 */
  unavailable: string;
};

function codexProvider({ fetch }: { fetch?: typeof globalThis.fetch } = {}): Provider {
  const native = withHostedSearch(openAICodexResponsesApi());
  const transport: ProviderStreams = {
    stream: (model, context, options) => native.stream({ ...model, api: "openai-codex-responses" }, context, { ...options, fetch: codexFetch(fetch ?? options?.fetch ?? globalThis.fetch) }),
    streamSimple: (model, context, options) => native.streamSimple({ ...model, api: "openai-codex-responses" }, context, { ...options, fetch: codexFetch(fetch ?? options?.fetch ?? globalThis.fetch) }),
  };
  const provider = createProvider({ id: CODEX_PROVIDER, name: "ChatGPT 订阅", baseUrl: CODEX_BASE_URL,
    auth: { oauth: codexOAuth }, models: Object.values(OPENAI_CODEX_MODELS)
      .map(model => ({ ...model, provider: CODEX_PROVIDER, compat: { ...model.compat,
        supportsMidConvoEffort: false, supportsLongCacheRetention: false,
        supportsExplicitPromptCacheMode: false, supportsMaxOutputTokens: false,
      } })), api: transport });
  return { ...provider, filterModels: (models, credential) => {
    if (!isChatGPTCredential(credential)) return [];
    return credential.catalog.flatMap(entry => {
      const model = models.find(model => model.id === entry.slug);
      return model ? [{ ...model, name: entry.display_name }] : [];
    });
  } };
}

export const MODEL_PROVIDERS: Record<string, ProviderSpec> = {
  deepseek: { name: "DeepSeek", listed: () => true, create: () => { const provider = deepseekProvider(); return { ...provider, ...withHostedSearch(provider, openAIResponsesApi()) }; }, unavailable: "missing_key" },
  [CODEX_PROVIDER]: { name: "ChatGPT 订阅", listed: () => true, create: codexProvider, unavailable: "login_required" },
  ...(FAUX_PROVIDER ? { faux: FAUX_PROVIDER } : {}),
};

/**
 * 每个 DO 建一份 Models：API key 从 env 读（不写 process.env），OAuth 凭据经 credentials 读写。
 * 当前用哪个模型不在这里决定，由调用方按运行时设置传给 pi-durable 或 directComplete。
 */
export function openModels(env: Env, credentials: CredentialStore, fetch?: typeof globalThis.fetch): MutableModels {
  const models = createModels({ credentials, authContext: {
    env: async name => { const value: unknown = (env as unknown as Record<string, unknown>)[name]; return typeof value === "string" && value.trim() ? value : undefined; },
    fileExists: async () => false,
  } });
  for (const spec of Object.values(MODEL_PROVIDERS)) if (spec.listed(env)) models.setProvider(spec.create({ fetch }));
  return models;
}

export type ProviderStatus = { id: string; name: string; available: boolean; reason?: string; models: { id: string; name: string }[] };
export async function providerStatuses(models: Models): Promise<ProviderStatus[]> {
  return Promise.all(models.getProviders().map(async provider => {
    const spec = MODEL_PROVIDERS[provider.id];
    // 凭据解不开（例如换了 OAUTH_STORE_KEY）也按不可用处理，不让面板与健康检查整体失败。
    const available = !!await models.checkAuth(provider.id).catch(() => undefined);
    return { id: provider.id, name: spec?.name ?? provider.name, available, ...(available ? {} : { reason: spec?.unavailable ?? "unavailable" }),
      models: (provider.id === CODEX_PROVIDER ? (available ? await models.getAvailable(provider.id) : []) : models.getModels(provider.id)).map(model => ({ id: model.id, name: model.name })) };
  }));
}
export function selectionProblem(providers: readonly ProviderStatus[], selection: ModelSelection): string | undefined {
  const provider = providers.find(provider => provider.id === selection.provider);
  if (!provider) return "unknown_provider";
  if (!provider.available) return provider.reason;
  return provider.models.some(model => model.id === selection.id) ? undefined : "unknown_model";
}
export const sameSelection = (a: ModelSelection, b: ModelSelection) => a.provider === b.provider && a.id === b.id && a.reasoningEffort === b.reasoningEffort;
/** pi-durable 的会话配置：推理强度对应 thinkingLevel，没设时清掉，回到模型默认。 */
export const modelChange = (selection: ModelSelection) => ({
  model: { provider: selection.provider, modelId: selection.id }, thinkingLevel: selection.reasoningEffort ?? null,
});
