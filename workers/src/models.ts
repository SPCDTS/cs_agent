import { createModels, createProvider, type Models, type MutableModels, type Provider } from "@earendil-works/pi-ai/models";
import type { Api, Model, Credential, CredentialStore, ProviderStreams } from "@earendil-works/pi-ai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { GOOGLE_MODELS } from "@earendil-works/pi-ai/providers/google.models";
import { openAICodexResponsesApi } from "@earendil-works/pi-ai/api/openai-codex-responses.lazy";
import { OPENAI_CODEX_MODELS } from "@earendil-works/pi-ai/providers/openai-codex.models";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import type { Env } from "./env";
import { withHostedSearch } from "./tools/web-search";
import { codexFetch } from "./codex-fetch";
import { CODEX_BASE_URL, CODEX_PROVIDER, codexOAuth, accountCodexCatalog, type CodexCatalogEntry } from "./codex-login";
import { FAUX_PROVIDER } from "./models-faux";
import type { ModelSelection } from "./settings";

export type CodexModels = readonly Model<Api>[];
type ProviderOptions = { fetch?: typeof globalThis.fetch; codexModels?: () => CodexModels };

export type ProviderSpec = {
  /** 面板显示名 */
  name: string;
  /** 不列出的 provider 也不能被选中；faux 只在测试配置里出现。 */
  listed(env: Env): boolean;
  create(options?: ProviderOptions): Provider;
  /** checkAuth 不通过时给面板与健康检查的原因 */
  unavailable: string;
};

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

function codexProvider({ fetch, codexModels = () => [] }: ProviderOptions = {}): Provider {
  const native = withHostedSearch(openAICodexResponsesApi());
  const transport: ProviderStreams = {
    stream: (model, context, options) => native.stream({ ...model, api: "openai-codex-responses" }, context, { ...options, fetch: codexFetch(fetch ?? options?.fetch ?? globalThis.fetch) }),
    streamSimple: (model, context, options) => native.streamSimple({ ...model, api: "openai-codex-responses" }, context, { ...options, fetch: codexFetch(fetch ?? options?.fetch ?? globalThis.fetch) }),
  };
  const provider = createProvider({ id: CODEX_PROVIDER, name: "ChatGPT 订阅", baseUrl: CODEX_BASE_URL,
    auth: { oauth: codexOAuth }, models: [], api: transport });
  const available = (_models: readonly unknown[], credential: Credential | undefined) => accountCodexCatalog(credential).map(codexModel);
  return { ...provider, getModels: codexModels, getAllModels: codexModels, filterModels: available, filterAllModels: available };
}

const GOOGLE_EXTRA_MODELS: readonly { id: string; name: string; maxTokens: number }[] = [
  { id: "gemini-4-carbon", name: "Gemini 4 Carbon", maxTokens: 32_768 },
  { id: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen", maxTokens: 65_536 },
  { id: "gemini-4-neon", name: "Gemini 4 Neon", maxTokens: 65_536 },
];

function geminiModels(): readonly Model<"google-generative-ai">[] {
  // 排除新账号已下线的 2.5 系列及非标准文本工具对话的专用端点。
  const builtin = Object.values(GOOGLE_MODELS).filter(model =>
    !model.id.startsWith("gemini-2.5-") && !model.id.startsWith("deep-research-")
    && !model.id.endsWith("-image") && !model.id.includes("-live"));
  const base = GOOGLE_MODELS["gemini-4-argon"];
  const known = new Set<string>(builtin.map(model => model.id));
  const extra = base ? GOOGLE_EXTRA_MODELS.filter(entry => !known.has(entry.id)).map(entry => ({ ...base, ...entry })) : [];
  return [...builtin, ...extra];
}

function geminiProvider(): Provider {
  // Google 适配器不允许传入自定义 fetch（拒绝 ModelAlarm.fetch），直连公开端点即可。
  const provider = googleProvider();
  const catalog = geminiModels();
  return { ...provider, getModels: () => catalog, getAllModels: () => catalog, ...withHostedSearch(provider) };
}

export const MODEL_PROVIDERS: Record<string, ProviderSpec> = {
  deepseek: { name: "DeepSeek", listed: () => true, create: () => { const provider = deepseekProvider(); return { ...provider, ...withHostedSearch(provider, openAIResponsesApi()) }; }, unavailable: "missing_key" },
  google: { name: "Gemini", listed: () => true, create: geminiProvider, unavailable: "missing_gemini_key" },
  [CODEX_PROVIDER]: { name: "ChatGPT 订阅", listed: () => true, create: codexProvider, unavailable: "login_required" },
  ...(FAUX_PROVIDER ? { faux: FAUX_PROVIDER } : {}),
};

/**
 * 每个 DO 建一份 Models：API key 从 env 读（不写 process.env），OAuth 凭据经 credentials 读写。
 * 当前用哪个模型不在这里决定，由调用方按运行时设置传给 pi-durable 或 directComplete。
 */
export function openModels(env: Env, credentials: CredentialStore, fetch?: typeof globalThis.fetch, codexModels?: () => CodexModels): MutableModels {
  const models = createModels({ credentials, authContext: {
    env: async name => { const value: unknown = (env as unknown as Record<string, unknown>)[name]; return typeof value === "string" && value.trim() ? value : undefined; },
    fileExists: async () => false,
  } });
  for (const spec of Object.values(MODEL_PROVIDERS)) if (spec.listed(env)) models.setProvider(spec.create({ fetch, codexModels }));
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
