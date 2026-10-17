/**
 * image_gen MCP 服务（设计 §4.4）：供容器内 codex 生图，复用 src/agent/image-gen.ts 的同一实现。
 * 输出目录只来自环境变量 IMAGE_TICKET_DIR（cs-agent 每次 codex exec 以 -c 注入 ${DATA_DIR}/images/<ticket>），
 * 工具参数里不接受路径；缺失、非法或不在 ${DATA_DIR}/images/ 的直接子目录时所有调用都拒绝。
 * 返回生成的文件名；图片由 cs-agent 在回合结束后从该目录收集并随回复发送。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { classifyImageError, type ImageBackend, type ImageBackendConfig } from "../agent/image-gen.js";
import { isLoopbackUrl } from "../agent/loopback-proxy.js";
import { loadConfig } from "../config.js";
import { collectNewImages, listFiles } from "../agent/image-collect.js";

export const PROMPT_MAX = 2000;
/** 每个 MCP 进程（即每个 codex 回合）最多生图次数；回复最多附带 4 张 */
export const MAX_CALLS = 4;

const TICKET_SEGMENT_RE = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * 校验 IMAGE_TICKET_DIR：绝对路径、不含 ".."、规范化后恰为 ${dataDir}/images/<段> 且段只含 [A-Za-z0-9_-]；
 * 创建目录后再用 realpath 确认仍在图片根目录内（防软链接）。返回目录 realpath，否则抛出说明原因的错误。
 */
export async function resolveTicketDir(raw: string | undefined, dataDir: string): Promise<string> {
  const v = (raw ?? "").trim();
  if (!v) throw new Error("IMAGE_TICKET_DIR 未设置");
  if (!path.isAbsolute(v) || v.split(/[\\/]/).includes("..")) throw new Error("IMAGE_TICKET_DIR 必须是不含 .. 的绝对路径");
  const root = path.resolve(dataDir, "images");
  const dir = path.resolve(v);
  const rel = path.relative(root, dir);
  if (!rel || rel.includes("/") || rel.includes("\\") || !TICKET_SEGMENT_RE.test(rel)) {
    throw new Error("IMAGE_TICKET_DIR 必须是 ${DATA_DIR}/images/ 下的票据目录");
  }
  await fs.mkdir(dir, { recursive: true });
  const realRoot = await fs.realpath(root);
  const realDir = await fs.realpath(dir);
  if (path.relative(realRoot, realDir) !== rel) throw new Error("IMAGE_TICKET_DIR 解析后不在图片目录内");
  return realDir;
}

/**
 * 由环境变量得到生图后端配置，与 agent 主进程（main.ts）同一规则：
 * mcp 模式且 COMFYUI_URL 不是 loopback 时改用 http://127.0.0.1:COMFY_LOOPBACK_PORT——主进程在那里监听 loopback 转发
 * （comfy-cli 只对 loopback 目标获取 object_info），MCP 子进程与主进程共享容器网络命名空间，可以直接连到。
 */
export function backendConfigFromEnv(env: NodeJS.ProcessEnv): ImageBackendConfig {
  const cfg = loadConfig(env);
  const comfyUrl =
    cfg.COMFY_MODE === "mcp" && !isLoopbackUrl(cfg.COMFYUI_URL) ? `http://127.0.0.1:${cfg.COMFY_LOOPBACK_PORT}` : cfg.COMFYUI_URL;
  return {
    mode: cfg.COMFY_MODE,
    comfyUrl,
    mcpBin: cfg.COMFY_MCP_BIN,
    comfyBin: cfg.COMFY_BIN,
    timeoutMs: cfg.COMFY_TIMEOUT_SEC * 1000,
    checkpoint: cfg.COMFY_CHECKPOINT || undefined,
    workflowFile: cfg.COMFY_WORKFLOW_FILE || undefined,
    promptNode: cfg.COMFY_PROMPT_NODE || undefined,
    baseEnv: env,
  };
}

export interface ImageGenDeps {
  /** 原始 IMAGE_TICKET_DIR */
  ticketDir: string | undefined;
  dataDir: string;
  /** 惰性创建生图后端（首次调用时） */
  createBackend: () => ImageBackend;
}

const TOOLS = [
  {
    name: "generate_image",
    description:
      "用本地 ComfyUI 根据画面描述生成一张图片。生成的图片会随你的回复自动发给 QQ 用户，你只需在回复里用一句话说明，不要写文件路径。提示词可以用中文。",
    inputSchema: {
      type: "object",
      properties: { prompt: { type: "string", description: `画面描述，≤${PROMPT_MAX} 字` } },
      required: ["prompt"],
      additionalProperties: false,
    },
    // 会写文件、调用外部服务：非只读
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
] as const;

const text = (t: string, isError = false): CallToolResult => ({ content: [{ type: "text", text: t }], ...(isError ? { isError } : {}) });

const FAILURE_TEXT: Record<string, string> = {
  unavailable: "生图服务暂时不可用",
  timeout: "生图超时",
  refused: "内容被拒绝生成",
  failed: "生图失败",
};

export function createImageGenServer(deps: ImageGenDeps): { server: Server; dispose: () => Promise<void> } {
  let backend: ImageBackend | undefined;
  let calls = 0;
  let chain: Promise<unknown> = Promise.resolve();
  const server = new Server(
    { name: "image_gen", version: "1.0.0" },
    { capabilities: { tools: {} }, instructions: "generate_image 生成的图片会随回复自动发给用户；回复只需一句说明。" },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS.map((t) => ({ ...t })) as never }));

  const generate = async (args: Record<string, unknown>): Promise<CallToolResult> => {
    let dir: string;
    try {
      dir = await resolveTicketDir(deps.ticketDir, deps.dataDir);
    } catch (err) {
      return text(`image_gen 不可用：${(err as Error).message}。`, true);
    }
    const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
    if (!prompt) return text("prompt 不能为空。", true);
    if (prompt.length > PROMPT_MAX) return text(`prompt 过长（>${PROMPT_MAX} 字）。`, true);
    if (calls >= MAX_CALLS) return text(`本次回复最多生成 ${MAX_CALLS} 次图片，已达上限。`, true);
    calls++;
    const before = await listFiles(dir);
    try {
      backend ??= deps.createBackend();
      await backend.generate(prompt, dir);
    } catch (err) {
      const kind = classifyImageError(err);
      process.stderr.write(`image_gen: generate failed (${kind}): ${(err as Error).message.slice(0, 300)}\n`);
      return text(`${FAILURE_TEXT[kind] ?? "生图失败"}，请如实告知用户。`, true);
    }
    const files = (await collectNewImages(dir, before)).map((f) => path.basename(f));
    if (!files.length) return text("生图没有产出有效图片。", true);
    return text(JSON.stringify({ files, note: "图片会随你的回复自动发送给用户" }));
  };

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (req.params.name !== "generate_image") return text(`未知工具：${req.params.name}`, true);
    // 同一进程内的调用串行（同一目录的前后差集才准确）
    const run = chain.then(() => generate((req.params.arguments ?? {}) as Record<string, unknown>));
    chain = run.catch(() => undefined);
    return run;
  });

  return {
    server,
    dispose: async () => {
      await backend?.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    },
  };
}
