import path from "node:path";
import { isValidId } from "./shared/qq-id.js";
import { z } from "zod";
import { DEFAULT_COMPACTION_POLICY } from "@earendil-works/pi-durable";

/** 逗号分隔列表；空串 → []。 */
const list = z
  .string()
  .default("")
  .transform((v) =>
    v
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? def : /^(1|true|yes|on)$/i.test(v)));

const int = (def: number) => z.coerce.number().int().positive().default(def);

const serviceUrl = z.string().url().refine(value => {
  const url = URL.parse(value); return !url?.username && !url?.password;
}, '服务 URL 不得包含用户名或密码');

export const DEFAULT_CODEX_MODEL = "codex/gpt-6.1-sol";

const EnvSchema = z.object({
  NAPCAT_HTTP_URL: serviceUrl.default("http://napcat:3000"),
  NAPCAT_WS_URL: serviceUrl.default("ws://napcat:3001"),
  NAPCAT_TOKEN: z.string().default(""),
  QQ_ALLOW_USERS: z.string().default(""),
  QQ_ALLOW_GROUPS: list,
  QQ_GROUP_MENTIONS: bool(true),

  MEDIA_RECALL_PORT: z.coerce.number().int().min(1).max(65535).default(8790),
  /** 每个回合的图片召回次数上限 */
  MEDIA_RECALL_MAX_PER_TURN: int(5),
  INCOMING_DOWNLOAD_CONCURRENCY: int(2),
  INCOMING_DOWNLOAD_DEADLINE_SEC: int(60),

  ATTACH_FILE_MAX_MB: int(20),
  ATTACH_FILES_MAX: int(3),
  ATTACH_FILE_DENY_EXT: z.string().default(".exe,.bat,.cmd,.ps1,.vbs,.js,.scr,.msi,.com,.lnk")
    .transform(v => v.split(",").map(ext => ext.trim().toLowerCase()).filter(Boolean)),

  CODEX_BIN: z.string().default("codex"),
  CODEX_PROVIDER: z.enum(["magpie", "openai"]).default("magpie"),
  /** codex 与 pi 共用的 magpie 网关地址。 */
  CODEX_MAGPIE_URL: serviceUrl.default("http://host.docker.internal:3425/v1"),
  /** codex 与 pi 共用的网关密钥，各自在启用 magpie 时校验；MCP 读取基础配置不要求凭据。 */
  CODEX_MAGPIE_KEY: z.string().default(""),
  CODEX_MODEL: z.string().default(DEFAULT_CODEX_MODEL),
  CODEX_CONTEXT_WINDOW: int(400000),
  /** codex 初始推理强度与 auto 失败时的回退档位（同时写入 config.toml） */
  CODEX_REASONING_EFFORT: z.string().default("high"),
  CODEX_SANDBOX: z.enum(["read-only", "workspace-write", "danger-full-access"]).default("workspace-write"),
  /** 官方 rollout trace 保留天数；0 禁用请求负载记录。 */
  CODEX_TRACE_RETENTION_DAYS: z.coerce.number().int().nonnegative().default(14),
  /** 官方 trace 普通文件总量上限（MiB）；0 表示不限。 */
  CODEX_TRACE_MAX_MB: z.coerce.number().int().nonnegative().max(Math.floor(Number.MAX_SAFE_INTEGER / 1024 / 1024)).default(512),
  /** codex 内置生图（imagegen）输出保留天数；0 禁用按天清理。 */
  CODEX_GENERATED_IMAGES_RETENTION_DAYS: z.coerce.number().int().nonnegative().default(7),
  /** codex 内置生图（imagegen）输出普通文件总量上限（MiB）；0 表示不限。 */
  CODEX_GENERATED_IMAGES_MAX_MB: z.coerce.number().int().nonnegative().max(Math.floor(Number.MAX_SAFE_INTEGER / 1024 / 1024)).default(1024),

  AGENT_MODEL_PROVIDER: z.string().default("deepseek"),
  AGENT_MODEL_ID: z.string().default("deepseek-flash"),
  AGENT_THINKING_LEVEL: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).default("low"),
  /** auto 选档模型始终取 magpie 提供者；空值禁用分类调用。 */
  AUTO_EFFORT_MODEL: z.string().trim().default("deepseek/deepseek-flash"),
  AUTO_EFFORT_TIMEOUT_MS: int(4000),
  /** 回合后记忆抽取的模型（magpie 提供者，docs/MEMORY-DESIGN.md §8.2）；未设置时取 AUTO_EFFORT_MODEL，两者都空则不抽取。 */
  MEMORY_EXTRACT_MODEL: z.string().trim().optional(),
  MEMORY_EXTRACT_TIMEOUT_MS: int(20000),
  AGENT_CONCURRENCY: int(2),
  /** 执行 agent 后端：codex | pi */
  AGENT_BACKEND: z.enum(["codex", "pi"]).default("codex"),
  /** 按 scope 覆盖后端：group:<群号>=pi,private:<QQ号>=codex */
  AGENT_BACKEND_OVERRIDES: z.string().default(""),
  /** 空值使用 DATA_DIR/skills；off 显式禁用。 */
  PI_SKILLS_DIR: z.string().default(""),
  /** 管理员维护的 MCP JSON 配置路径；空值禁用新调用。 */
  PI_MCP_CONFIG: z.string().default(""),
  PI_ARCHIVE_RETENTION_DAYS: int(90),
  PI_COMPACTION_RESERVE_TOKENS: int(DEFAULT_COMPACTION_POLICY.reserveTokens),
  PI_COMPACTION_BACKGROUND_TOKENS: z.coerce.number().int().min(0).default(DEFAULT_COMPACTION_POLICY.backgroundTokens),

  /** owner QQ 号列表（逗号分隔），共享私聊线程与全部权限；首项为主账号；留空 = QQ_ALLOW_USERS 第一项。 */
  QQ_OWNER: z.string().default("").refine(v => v.split(",").map(s => s.trim()).filter(Boolean).every(isValidId),
    "QQ_OWNER 必须是逗号分隔的有效 QQ 号列表"),
  /** 统一上下文消息库：原始消息保留天数、摘要保留天数、每日衰老任务的本地小时（容器默认 UTC） */
  HISTORY_RAW_DAYS: int(30),
  HISTORY_SUMMARY_DAYS: int(180),
  /** 未被日/周摘要覆盖（摘要失败或条数不足）的原始消息最长保留天数 */
  HISTORY_RAW_HARD_MAX_DAYS: int(90),
  HISTORY_SUMMARY_HOUR: z.coerce.number().int().min(0).max(23).default(3),
  /** recent/search 返回文本的总字数上限（意图层与 qq_context MCP 共用） */
  QQ_CONTEXT_MAX_CHARS: int(2500),
  /** codex web_search：live | cached | disabled；结果注入量 low | medium | high（由 entrypoint 写入 config.toml） */
  CODEX_WEB_SEARCH: z.enum(["live", "cached", "disabled"]).default("live"),
  CODEX_WEB_SEARCH_CONTEXT: z.enum(["low", "medium", "high"]).default("low"),
  /** codex 单线程安全阀：rollout 文件超过 N MB 或线程超过 N 天则新建线程 */
  CODEX_ROLLOUT_MAX_MB: int(50),
  CODEX_THREAD_MAX_DAYS: int(90),
  /** codex 浏览器 MCP：playwright（headless Chromium）| none */
  CODEX_BROWSER: z.enum(["playwright", "none"]).default("playwright"),
  /** 由 entrypoint 写入 config.toml 的 [sandbox_workspace_write]：命令是否可联网、可写目录（逗号分隔绝对路径） */
  CODEX_SANDBOX_NETWORK: bool(true),
  CODEX_WRITABLE_ROOTS: z.string().default("/workspace,/data/prompts"),

  DATA_DIR: z.string().default("/data"),
  WORKSPACE_DIR: z.string().default("/workspace"),
  /** 每个 trace 键（回合 / 输入 / 会话）最多保存的观测事件数 */
  OBS_EVENT_CAP: z.coerce.number().int().min(8).max(10000).default(500),
  OBS_RETENTION_DAYS: int(30),
  OBS_MEMORY_RETENTION_DAYS: z.coerce.number().int().nonnegative().default(90),
  OBS_ADMIN_RETENTION_DAYS: int(365),
  OBS_TOKEN: z.string().default(""),
  ALERT_OWNER: bool(false),
  DEEPSEEK_PRICE_IN_PER_M: z.coerce.number().finite().nonnegative().default(0),
  DEEPSEEK_PRICE_OUT_PER_M: z.coerce.number().finite().nonnegative().default(0),
  HEALTH_PORT: int(8787),
  HEALTH_HOST: z.string().default("127.0.0.1"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

type Env = z.infer<typeof EnvSchema>;

export interface Config extends Omit<Env, "MEMORY_EXTRACT_MODEL"> {
  /** 已按缺省取 AUTO_EFFORT_MODEL；空字符串表示不抽取 */
  MEMORY_EXTRACT_MODEL: string;
  allowUsers: string[] | "*";
  /** ${DATA_DIR}/codex，容器内 codex 与 pi-ai 共用的 CODEX_HOME */
  codexHome: string;
  imagesDir: string;
}

/** 环境变量别名 → pi-ai 读取的标准名（.env 中常见的写法差异）。 */
const ENV_ALIASES: Readonly<Record<string, string>> = {
  DEEPSEEK_APIKEY: "DEEPSEEK_API_KEY",
};

/** API key provider 需要的环境变量（pi-ai 按标准名读取）。 */
const PROVIDER_API_KEY_ENV: Readonly<Record<string, string>> = {
  deepseek: "DEEPSEEK_API_KEY",
  magpie: "CODEX_MAGPIE_KEY",
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
};

/** 标准名未设置（或为空）而别名已设置时，把别名的值复制到标准名；原地修改 env。 */
export function applyEnvAliases(env: NodeJS.ProcessEnv = process.env): void {
  for (const [alias, canonical] of Object.entries(ENV_ALIASES)) {
    if (!env[canonical] && env[alias]) env[canonical] = env[alias];
  }
}

/**
 * API key provider 缺少密钥时抛错（启动即失败，而不是等第一条消息才报鉴权错误）。
 * 应在 applyEnvAliases 之后调用；只检查是否存在，不读取/输出值。
 */
export function requireProviderApiKey(provider: string, env: NodeJS.ProcessEnv = process.env): void {
  const keyEnv = PROVIDER_API_KEY_ENV[provider];
  if (!keyEnv || env[keyEnv]) return;
  const aliases = Object.entries(ENV_ALIASES)
    .filter(([, c]) => c === keyEnv)
    .map(([a]) => a);
  throw new Error(`配置无效: AGENT_MODEL_PROVIDER=${provider} 需要设置 ${[keyEnv, ...aliases].join(" 或 ")}`);
}

/** 改名前的环境变量名 → 现名：旧部署的 .env 继续生效，现名优先。 */
const RENAMED_ENV: [string, string][] = [["MEDIA_RECALL_MAX_PER_TICKET", "MEDIA_RECALL_MAX_PER_TURN"], ["OBS_TICKET_EVENT_CAP", "OBS_EVENT_CAP"]];

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // 通常将空字符串视为未设置；AUTO_EFFORT_MODEL 的空值专门表示禁用分类。
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ""));
  for (const [legacy, name] of RENAMED_ENV) {
    if (cleaned[name] === undefined && cleaned[legacy] !== undefined) cleaned[name] = cleaned[legacy];
    delete cleaned[legacy];
  }
  if (env.AUTO_EFFORT_MODEL !== undefined) cleaned.AUTO_EFFORT_MODEL = env.AUTO_EFFORT_MODEL;
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`配置无效: ${issues}`);
  }
  const e = parsed.data;
  const users = e.QQ_ALLOW_USERS.trim();
  const allowUsers: string[] | "*" =
    users === "*"
      ? "*"
      : users
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
  return {
    ...e,
    PI_SKILLS_DIR: e.PI_SKILLS_DIR || path.join(e.DATA_DIR, "skills"),
    MEMORY_EXTRACT_MODEL: e.MEMORY_EXTRACT_MODEL ?? e.AUTO_EFFORT_MODEL,
    allowUsers,
    codexHome: path.join(e.DATA_DIR, "codex"),
    imagesDir: path.join(e.DATA_DIR, "images"),
  };
}
