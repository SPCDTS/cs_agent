// 配置可被部署覆盖，不能沿用生成文件中的字面量类型；绑定仍由 Wrangler 生成。
export interface Env extends Omit<Cloudflare.Env, "MODEL_PROVIDER" | "MODEL_ID" | "QQ_GROUP_MENTIONS" | "MEMORY_EXTRACT_MODEL" | "MEMORY_EXTRACT_NAMESPACES" | "PUBLIC_ORIGIN" | "GMAIL_PUBSUB_SERVICE_ACCOUNT" | "GMAIL_PUBSUB_TOPIC"> {
  PUBLIC_ORIGIN: string;
  // Pub/Sub 推送的服务账号邮箱与 Gmail watch 的 topic；为空时只靠 Cron 轮询
  GMAIL_PUBSUB_SERVICE_ACCOUNT?: string;
  GMAIL_PUBSUB_TOPIC?: string;
  OAUTH_STORE_KEY?: string;
  // 默认模型；运行时以 Registry 设置里的 model 为准（面板切换）
  MODEL_PROVIDER: string;
  MODEL_ID: string;
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
  CS2_WORKSHOP_AUTHORIZATION?: string;
  // 维护任务的保留天数（0 = 不清理）；缺省见 maintenance/index.ts
  HISTORY_RAW_DAYS?: string;
  HISTORY_RAW_HARD_MAX_DAYS?: string;
  HISTORY_SUMMARY_DAYS?: string;
  EVENTS_RETENTION_DAYS?: string;
  // Gmail 桌面客户端与 owner 的 refresh token（secrets）；任一缺失时 Gmail 来源与工具报 auth
  GITHUB_WEBHOOK_SECRET?: string;
  GITHUB_MODE?: "manual" | "app";
  GITHUB_APP_ID?: string;
  GITHUB_APP_SLUG?: string;
  GITHUB_APP_CLIENT_ID?: string;
  GITHUB_APP_CALLBACK_URL?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_APP_CLIENT_SECRET?: string;
  GITHUB_APP_WEBHOOK_SECRET?: string;
  GITHUB_APP_STORE_KEY?: string;
  GMAIL_CLIENT_ID?: string;
  GMAIL_CLIENT_SECRET?: string;
  GMAIL_REFRESH_TOKEN?: string;
}
