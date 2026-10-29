import { createModels, createProvider, type Models, type MutableModels, type Provider } from "@earendil-works/pi-ai/models";
import type { Api, CredentialStore, Model } from "@earendil-works/pi-ai";
import { fauxProvider, fauxToolCall, fauxAssistantMessage, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { OPENAI_CODEX_MODELS } from "@earendil-works/pi-ai/providers/openai-codex.models";
import { openAICodexResponsesApi } from "@earendil-works/pi-ai/api/openai-codex-responses.lazy";
import type { Env } from "./env";
import { CODEX_PROVIDER, codexOAuth } from "./codex-login";
import type { ModelSelection } from "./settings";

type ProviderSpec = {
  /** 面板显示名 */
  name: string;
  /** 不列出的 provider 也不能被选中；faux 只在测试配置里出现。 */
  listed(env: Env): boolean;
  create(): Provider;
  /** checkAuth 不通过时给面板与健康检查的原因 */
  unavailable: string;
  /** 能代其他模型联网搜索、生成图片的 provider 才有：从目录里挑代答用的模型。 */
  searchModel?(catalog: readonly Model<Api>[]): string | undefined;
};

// pi-ai 自带的 openaiCodexProvider 的 OAuth 经 lazyOAuth 用变量路径加载，Worker 里加载不到；目录与 API 照用，auth 换成 codexOAuth。
function codexProvider(): Provider {
  return createProvider({ id: CODEX_PROVIDER, name: "OpenAI Codex", baseUrl: "https://chatgpt.com/backend-api",
    auth: { oauth: codexOAuth }, models: Object.values(OPENAI_CODEX_MODELS), api: openAICodexResponsesApi() });
}

function echoProvider(): Provider {
  const faux = fauxProvider({ models: [{ id: "test" }, { id: "test-alt" }], tokensPerSecond: Infinity });
  const respond: FauxResponseFactory = transcript => {
    // 工厂也是一次性队列项，补回自身才能覆盖后续回合及驱逐后的工具续轮。
    faux.setResponses([respond]);
    if (transcript.messages.at(-1)?.role === "toolResult") return fauxAssistantMessage("done");
    const user = transcript.messages.findLast(message => message.role === "user");
    const text = typeof user?.content === "string" ? user.content
      : user?.content.filter(block => block.type === "text").map(block => block.text).join("") ?? "";
    return fauxAssistantMessage(fauxToolCall("send_message", { text: `echo: ${text}` }), { stopReason: "toolUse" });
  };
  faux.setResponses([respond]);
  return faux.provider;
}

export const MODEL_PROVIDERS: Record<string, ProviderSpec> = {
  deepseek: { name: "DeepSeek", listed: () => true, create: deepseekProvider, unavailable: "missing_key" },
  [CODEX_PROVIDER]: { name: "ChatGPT 订阅（Codex）", listed: () => true, create: codexProvider, unavailable: "login_required",
    // 代答只要能调托管工具，挑最便宜的：先找 mini / nano，目录里没有就按标价取最低。
    searchModel: catalog => (catalog.find(model => /mini|nano/i.test(model.id))
      ?? catalog.toSorted((a, b) => a.cost.input + a.cost.output - b.cost.input - b.cost.output)[0])?.id },
  faux: { name: "faux（测试）", listed: env => env.MODEL_PROVIDER === "faux", create: echoProvider, unavailable: "unavailable" },
};

/**
 * 每个 DO 建一份 Models：API key 从 env 读（不写 process.env），OAuth 凭据经 credentials 读写。
 * 当前用哪个模型不在这里决定，由调用方按运行时设置传给 pi-durable 或 directComplete。
 */
export function openModels(env: Env, credentials: CredentialStore): MutableModels {
  const models = createModels({ credentials, authContext: {
    env: async name => { const value: unknown = (env as unknown as Record<string, unknown>)[name]; return typeof value === "string" && value.trim() ? value : undefined; },
    fileExists: async () => false,
  } });
  for (const spec of Object.values(MODEL_PROVIDERS)) if (spec.listed(env)) models.setProvider(spec.create());
  return models;
}

export type ProviderStatus = { id: string; name: string; available: boolean; reason?: string; models: { id: string; name: string }[] };
export async function providerStatuses(models: Models): Promise<ProviderStatus[]> {
  return Promise.all(models.getProviders().map(async provider => {
    const spec = MODEL_PROVIDERS[provider.id];
    // 凭据解不开（例如换了 OAUTH_STORE_KEY）也按不可用处理，不让面板与健康检查整体失败。
    const available = !!await models.checkAuth(provider.id).catch(() => undefined);
    return { id: provider.id, name: spec?.name ?? provider.name, available, ...(available ? {} : { reason: spec?.unavailable ?? "unavailable" }),
      models: models.getModels(provider.id).map(model => ({ id: model.id, name: model.name })) };
  }));
}
export function selectionProblem(providers: readonly ProviderStatus[], selection: ModelSelection): string | undefined {
  const provider = providers.find(provider => provider.id === selection.provider);
  if (!provider) return "unknown_provider";
  if (!provider.models.some(model => model.id === selection.id)) return "unknown_model";
  return provider.available ? undefined : provider.reason;
}
export const sameSelection = (a: ModelSelection, b: ModelSelection) => a.provider === b.provider && a.id === b.id && a.reasoningEffort === b.reasoningEffort;
/** pi-durable 的会话配置：推理强度对应 thinkingLevel，没设时清掉，回到模型默认。 */
export const modelChange = (selection: ModelSelection) => ({
  model: { provider: selection.provider, modelId: selection.id }, thinkingLevel: selection.reasoningEffort ?? null,
});
