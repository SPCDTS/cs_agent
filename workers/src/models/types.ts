import type { Api, Model } from "@earendil-works/pi-ai";
import type { Provider } from "@earendil-works/pi-ai/models";
import type { Env } from "../env";

export type ProviderCatalogs = Partial<Record<string, readonly Model<Api>[]>>;
export type ProviderOptions = { fetch?: typeof globalThis.fetch; catalogs?: () => ProviderCatalogs };

export type ProviderSpec = {
  /** 面板显示名 */
  name: string;
  /** 不列出的 provider 也不能被选中；faux 只在测试配置里出现。 */
  listed(env: Env): boolean;
  create(options?: ProviderOptions): Provider;
  /** checkAuth 不通过时给面板与健康检查的原因 */
  unavailable: string;
  /** 若凭据来自 Env secret，声明环境变量名供管理台概览统计是否已配置。 */
  secretName?: keyof Env;
  /** 是否依赖从 Registry 加载动态账号模型目录。 */
  dynamicCatalog?: boolean;
  /** 是否通过 CredentialStore.getAvailable 读取当前账号可用模型。 */
  credentialScopedModels?: boolean;
};
