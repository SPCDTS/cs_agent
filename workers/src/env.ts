// 配置可被部署覆盖，不能沿用生成文件中的字面量类型；绑定仍由 Wrangler 生成。
export interface Env extends Omit<Cloudflare.Env, "MODEL_PROVIDER" | "MODEL_ID" | "MAGPIE_URL" | "QQ_GROUP_MENTIONS" | "MEMORY_EXTRACT_MODEL" | "MEMORY_EXTRACT_NAMESPACES" | "PUBLIC_ORIGIN"> {
  PUBLIC_ORIGIN: string;
  OAUTH_STORE_KEY?: string;
  MODEL_PROVIDER: string;
  MODEL_ID: string;
  MAGPIE_URL: string;
  QQ_GROUP_MENTIONS?: string | boolean;
  // 以下都是 secrets：QQ 号不进仓库与配置文件
  QQ_OWNER?: string;
  QQ_ALLOW_USERS?: string;
  QQ_ALLOW_GROUPS?: string;
  NAPCAT_TOKEN?: string;
  ADMIN_TOKEN?: string;
  MEMORY_EXTRACT_MODEL?: string;
  MEMORY_EXTRACT_NAMESPACES?: string;
  DEEPSEEK_API_KEY?: string;
  MAGPIE_GATEWAY_KEY?: string;
  // magpie 容器从 R2 取回状态所需（secrets）；本地 dev 与测试不设
  R2_BUCKET?: string;
  R2_ENDPOINT?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  MAGPIE_SYNC_PASSPHRASE?: string;
  // 维护任务的保留天数（0 = 不清理）；缺省见 maintenance/index.ts
  HISTORY_RAW_DAYS?: string;
  HISTORY_RAW_HARD_MAX_DAYS?: string;
  HISTORY_SUMMARY_DAYS?: string;
  EVENTS_RETENTION_DAYS?: string;
}
