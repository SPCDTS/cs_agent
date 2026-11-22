import { createModels, type Models, type MutableModels } from "@earendil-works/pi-ai/models";
import type { CredentialStore } from "@earendil-works/pi-ai";
import type { Env } from "../env";
import type { RegistryDO } from "../registry";
import type { ModelSelection } from "../settings";
import { DEEPSEEK_PROVIDER, DEEPSEEK_SPEC } from "./providers/deepseek";
import { GOOGLE_PROVIDER, GOOGLE_SPEC } from "./providers/google";
import { CODEX_PROVIDER, CODEX_SPEC, codexModel, type CodexCatalogEntry } from "./providers/codex";
import { FAUX_PROVIDER } from "./providers/faux";
import type { ProviderCatalogs, ProviderOptions, ProviderSpec } from "./types";

export type { ProviderCatalogs, ProviderOptions, ProviderSpec } from "./types";
export { ModelAlarm, responseAlarmWaitMs } from "./alarm";
export { MODEL_CREDENTIALS_SCHEMA, SqlCredentialStore, remoteCredentials, type CredentialLease, type CredentialMeta } from "./credentials";
export { modelEgressDiagnostics } from "./egress";
export { agentSearchOption, hostedSearchSteps, withResponsesSearch, type SearchItem, type SearchOptions, type SearchStep } from "./hosted-search";

export const MODEL_PROVIDERS: Record<string, ProviderSpec> = {
  [DEEPSEEK_PROVIDER]: DEEPSEEK_SPEC,
  [GOOGLE_PROVIDER]: GOOGLE_SPEC,
  [CODEX_PROVIDER]: CODEX_SPEC,
  ...(FAUX_PROVIDER ? { faux: FAUX_PROVIDER } : {}),
};

/** 汇总所有声明了 Env secret 凭据的供应商环境变量名，供管理台配置概览复用。 */
export const PROVIDER_SECRET_NAMES = Object.values(MODEL_PROVIDERS).flatMap(spec => spec.secretName ? [spec.secretName] : []);

export const usesDynamicCatalog = (provider: string): boolean => !!MODEL_PROVIDERS[provider]?.dynamicCatalog;

export function hydrateCatalogs(snapshot: { catalog: readonly CodexCatalogEntry[] }): ProviderCatalogs {
  return { [CODEX_PROVIDER]: snapshot.catalog.map(codexModel) };
}

export async function loadProviderCatalogs(registry: DurableObjectStub<RegistryDO>): Promise<ProviderCatalogs> {
  return hydrateCatalogs({ catalog: await registry.codexCatalog() });
}

/**
 * 每个 DO 建一份 Models：API key 从 env 读（不写 process.env），OAuth 凭据经 credentials 读写。
 * 当前用哪个模型不在这里决定，由调用方按运行时设置传给 pi-durable 或 directComplete。
 */
export function openModels(env: Env, credentials: CredentialStore, fetch?: typeof globalThis.fetch, catalogs?: () => ProviderCatalogs): MutableModels {
  const models = createModels({ credentials, authContext: {
    env: async name => { const value: unknown = (env as unknown as Record<string, unknown>)[name]; return typeof value === "string" && value.trim() ? value : undefined; },
    fileExists: async () => false,
  } });
  for (const spec of Object.values(MODEL_PROVIDERS)) if (spec.listed(env)) models.setProvider(spec.create({ fetch, catalogs }));
  return models;
}

export type ProviderStatus = { id: string; name: string; available: boolean; reason?: string; models: { id: string; name: string }[] };
export async function providerStatuses(models: Models): Promise<ProviderStatus[]> {
  return Promise.all(models.getProviders().map(async provider => {
    const spec = MODEL_PROVIDERS[provider.id];
    // 凭据解不开（例如换了 OAUTH_STORE_KEY）也按不可用处理，不让面板与健康检查整体失败。
    const available = !!await models.checkAuth(provider.id).catch(() => undefined);
    const list = spec?.credentialScopedModels ? (available ? await models.getAvailable(provider.id) : []) : models.getModels(provider.id);
    return { id: provider.id, name: spec?.name ?? provider.name, available, ...(available ? {} : { reason: spec?.unavailable ?? "unavailable" }),
      models: list.map(model => ({ id: model.id, name: model.name })) };
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
