import path from "node:path";
import { z } from "zod";
import { resolveOwner } from "./context/access.js";
import { parseImagePrefixes } from "./agent/router.js";
import { parseBackendOverrides } from "./agent/backends/select.js";
import type { BackendName } from "./agent/backends/types.js";
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

export const DEFAULT_WORKFLOW = "qwen-image-2.1-turbo-api.json";

const serviceUrl = z.string().url().refine(value => {
  const url = new URL(value); return !url.username && !url.password;
}, '服务 URL 不得包含用户名或密码');

const EnvSchema = z.object({
  NAPCAT_HTTP_URL: serviceUrl.default("http://host.docker.internal:3000"),
  NAPCAT_WS_URL: serviceUrl.default("ws://host.docker.internal:3001"),
  NAPCAT_TOKEN: z.string().default(""),
  QQ_ALLOW_USERS: z.string().default(""),
  QQ_ALLOW_GROUPS: list,
  QQ_GROUP_MENTIONS: bool(true),

  COMFYUI_URL: z.string().url().default("http://host.docker.internal:8188"),
  COMFY_MODE: z.enum(["mcp", "http"]).default("mcp"),
  COMFY_MCP_BIN: z.string().default("/opt/comfy/bin/comfy-mcp"),
  COMFY_BIN: z.string().default("/opt/comfy/bin/comfy"),
  COMFY_CHECKPOINT: z.string().default(""),
  /** 显式设置时覆盖生成器；空值使用参数化 Qwen Image 2.1 Turbo 图。 */
  COMFY_WORKFLOW_FILE: z.string().default(""),
  COMFY_QWEN_CACHE: bool(false),
  COMFY_PROMPT_NODE: z.string().default(""),
  /** mcp 模式下容器内 loopback 转发端口（comfy-cli 仅对 loopback 获取 object_info） */
  COMFY_LOOPBACK_PORT: int(8188),
  COMFY_TIMEOUT_SEC: int(300),
  INCOMING_DOWNLOAD_CONCURRENCY: int(2),
  INCOMING_DOWNLOAD_DEADLINE_SEC: int(60),
  IMAGE_COLLECT_EXTENSIONS: z.coerce.number().int().min(0).max(10).default(2),
  IMAGE_GEN_MCP_WAIT_SEC: int(90),

  CODEX_BIN: z.string().default("codex"),
  CODEX_MODEL: z.string().default("gpt-6.1-sol"),
  /** codex 推理强度（写入 config.toml，codex 后端每轮也以 -c 显式传入；不再按请求选择） */
  CODEX_REASONING_EFFORT: z.string().default("high"),
  /** codex 后端回复后处理：relay（意图模型整理格式，失败回退清洗）| direct（仅代码清洗） */
  CODEX_REPLY_MODE: z.enum(["relay", "direct"]).default("relay"),
  CODEX_SANDBOX: z.enum(["read-only", "workspace-write", "danger-full-access"]).default("workspace-write"),
  CODEX_TIMEOUT_SEC: int(600),

  AGENT_MODEL_PROVIDER: z.string().default("deepseek"),
  AGENT_MODEL_ID: z.string().default("deepseek-flash"),
  AGENT_THINKING_LEVEL: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).default("low"),
  AGENT_CONCURRENCY: int(2),
  /** 规则分流的生图前缀（逗号分隔，逐字匹配）；命中后前缀之后的全部文本作为提示词 */
  IMAGE_PREFIXES: z.string().default("奶龙:,奶龙："),
  /** 执行 agent 后端：codex | pi */
  AGENT_BACKEND: z.enum(["codex", "pi"]).default("codex"),
  /** 按 scope 覆盖后端：group:<群号>=pi,private:<QQ号>=codex */
  AGENT_BACKEND_OVERRIDES: z.string().default(""),
  PI_TURN_TIMEOUT_SEC: int(300),
  PI_ARCHIVE_RETENTION_DAYS: int(90),
  PI_COMPACTION_RESERVE_TOKENS: int(DEFAULT_COMPACTION_POLICY.reserveTokens),
  PI_COMPACTION_BACKGROUND_TOKENS: z.coerce.number().int().min(0).default(DEFAULT_COMPACTION_POLICY.backgroundTokens),

  /** owner QQ 号（私聊可检索全部会话历史）；留空 = QQ_ALLOW_USERS 的第一项 */
  QQ_OWNER: z.string().regex(/^\d*$/, "QQ_OWNER 必须是 QQ 号").default(""),
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
  CODEX_WRITABLE_ROOTS: z.string().default("/workspace,/data/prompts,/data/workflows"),

  DATA_DIR: z.string().default("/data"),
  WORKSPACE_DIR: z.string().default("/workspace"),
  OBS_TICKET_EVENT_CAP: z.coerce.number().int().min(8).max(10000).default(500),
  OBS_RETENTION_DAYS: int(30),
  OBS_ADMIN_RETENTION_DAYS: int(365),
  OBS_TOKEN: z.string().default(""),
  ALERT_OWNER: bool(false),
  DEEPSEEK_PRICE_IN_PER_M: z.coerce.number().finite().nonnegative().default(0),
  DEEPSEEK_PRICE_OUT_PER_M: z.coerce.number().finite().nonnegative().default(0),
  HEALTH_PORT: int(8787),
  HEALTH_HOST: z.string().default("127.0.0.1"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Env = z.infer<typeof EnvSchema>;

export interface Config extends Env {
  allowUsers: string[] | "*";
  /** ${DATA_DIR}/codex，容器内 codex 与 pi-ai 共用的 CODEX_HOME */
  codexHome: string;
  imagesDir: string;
  /** ${DATA_DIR}/tickets：每张票据的工作目录（codex 回合的 codex-last.txt），回复后清理 */
  ticketsDir: string;
  /** QQ_OWNER，否则 QQ_ALLOW_USERS 第一项；QQ_ALLOW_USERS=* 且未设 QQ_OWNER 时无 owner */
  owner: string | undefined;
  imagePrefixes: string[];
  backendOverrides: Record<string, BackendName>;
}

/** 环境变量别名 → pi-ai 读取的标准名（.env 中常见的写法差异）。 */
export const ENV_ALIASES: Readonly<Record<string, string>> = {
  DEEPSEEK_APIKEY: "DEEPSEEK_API_KEY",
};

/** API key provider 需要的环境变量（pi-ai 按标准名读取）。 */
export const PROVIDER_API_KEY_ENV: Readonly<Record<string, string>> = {
  deepseek: "DEEPSEEK_API_KEY",
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // 空字符串视为未设置，便于 .env 中留空项走默认值
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ""));
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`配置无效: ${issues}`);
  }
  const e = parsed.data;
  let backendOverrides: Record<string, BackendName>;
  try {
    backendOverrides = parseBackendOverrides(e.AGENT_BACKEND_OVERRIDES);
  } catch (err) {
    throw new Error(`配置无效: ${(err as Error).message}`);
  }
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
    allowUsers,
    codexHome: path.join(e.DATA_DIR, "codex"),
    imagesDir: path.join(e.DATA_DIR, "images"),
    ticketsDir: path.join(e.DATA_DIR, "tickets"),
    owner: resolveOwner(e.QQ_OWNER, allowUsers),
    imagePrefixes: parseImagePrefixes(e.IMAGE_PREFIXES),
    backendOverrides,
  };
}
