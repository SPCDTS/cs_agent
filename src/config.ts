import path from "node:path";
import { z } from "zod";
import { resolveOwner } from "./context/access.js";

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

const EnvSchema = z.object({
  NAPCAT_HTTP_URL: z.string().url().default("http://host.docker.internal:3000"),
  NAPCAT_WS_URL: z.string().url().default("ws://host.docker.internal:3001"),
  NAPCAT_TOKEN: z.string().default(""),
  QQ_ALLOW_USERS: z.string().default(""),
  QQ_ALLOW_GROUPS: list,
  QQ_GROUP_MENTIONS: bool(true),

  COMFYUI_URL: z.string().url().default("http://host.docker.internal:8188"),
  COMFY_MODE: z.enum(["mcp", "http"]).default("mcp"),
  COMFY_MCP_BIN: z.string().default("/opt/comfy/bin/comfy-mcp"),
  COMFY_BIN: z.string().default("/opt/comfy/bin/comfy"),
  COMFY_CHECKPOINT: z.string().default(""),
  /** API 格式工作流文件；为空时 mcp 用 generate_image 默认模板，http 用内置 SD1.5 工作流 */
  /** 未设置时为 ${DATA_DIR}/workflows/qwen-image-2.1-turbo-api.json（entrypoint 从 /app/workflows 播种，codex 可改）；旧的 /app/... 路径仍可显式设置 */
  COMFY_WORKFLOW_FILE: z.string().default(""),
  COMFY_PROMPT_NODE: z.string().default(""),
  /** mcp 模式下容器内 loopback 转发端口（comfy-cli 仅对 loopback 获取 object_info） */
  COMFY_LOOPBACK_PORT: int(8188),
  COMFY_TIMEOUT_SEC: int(300),

  CODEX_BIN: z.string().default("codex"),
  CODEX_MODEL: z.string().default("gpt-6.1-sol"),
  /** config.toml 中的默认推理强度；ask_codex 每轮由意图模型选择的档位会覆盖它 */
  CODEX_REASONING_EFFORT: z.string().default("high"),
  CODEX_SANDBOX: z.enum(["read-only", "workspace-write", "danger-full-access"]).default("workspace-write"),
  CODEX_TIMEOUT_SEC: int(600),

  AGENT_MODEL_PROVIDER: z.string().default("deepseek"),
  AGENT_MODEL_ID: z.string().default("deepseek-flash"),
  AGENT_THINKING_LEVEL: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).default("low"),
  AGENT_CONCURRENCY: int(2),

  /** owner QQ 号（私聊可检索全部会话历史）；留空 = QQ_ALLOW_USERS 的第一项 */
  QQ_OWNER: z.string().regex(/^\d*$/, "QQ_OWNER 必须是 QQ 号").default(""),
  /** 统一上下文消息库：原始消息保留天数、摘要保留天数、每日衰老任务的本地小时（容器默认 UTC） */
  HISTORY_RAW_DAYS: int(30),
  HISTORY_SUMMARY_DAYS: int(180),
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
  /** QQ_OWNER，否则 QQ_ALLOW_USERS 第一项；QQ_ALLOW_USERS=* 且未设 QQ_OWNER 时无 owner */
  owner: string | undefined;
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
    COMFY_WORKFLOW_FILE: e.COMFY_WORKFLOW_FILE || path.posix.join(e.DATA_DIR, "workflows", DEFAULT_WORKFLOW),
    owner: resolveOwner(e.QQ_OWNER, allowUsers),
  };
}
