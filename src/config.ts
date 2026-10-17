import path from "node:path";
import { z } from "zod";

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
  COMFY_WORKFLOW_FILE: z.string().default(""),
  COMFY_PROMPT_NODE: z.string().default(""),
  /** mcp 模式下容器内 loopback 转发端口（comfy-cli 仅对 loopback 获取 object_info） */
  COMFY_LOOPBACK_PORT: int(8188),
  COMFY_TIMEOUT_SEC: int(300),

  CODEX_BIN: z.string().default("codex"),
  CODEX_MODEL: z.string().default("gpt-6-astra"),
  CODEX_REASONING_EFFORT: z.string().default("high"),
  CODEX_SANDBOX: z.enum(["read-only", "workspace-write", "danger-full-access"]).default("workspace-write"),
  CODEX_TIMEOUT_SEC: int(600),

  AGENT_MODEL_PROVIDER: z.string().default("openai-codex"),
  AGENT_MODEL_ID: z.string().default("gpt-6-luna"),
  AGENT_THINKING_LEVEL: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).default("low"),
  AGENT_CONCURRENCY: int(2),

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
  };
}
