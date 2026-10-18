import { observeImages } from "../obs/image.js";
import { IMAGE_OPTIONS_JSON_SCHEMA, validateImageOptions, type ImageOptions } from "../agent/image-options.js";
import { imageRefsValue, validateReferences } from "../agent/image-references.js";
/**
 * image_gen MCP 服务（设计 §4.4）：供容器内 codex 生图，复用 src/agent/image-gen.ts 的同一实现。
 * 输出目录只来自环境变量 IMAGE_TICKET_DIR（cs-agent 每次 codex exec 以 -c 注入 ${DATA_DIR}/images/<ticket>），
 * 工具参数里不接受输出路径（参考图仅接受 IMAGE_REFS 允许列表）；缺失、非法或不在 ${DATA_DIR}/images/ 的直接子目录时所有调用都拒绝。
 * 每次调用输出到新的子目录 <IMAGE_TICKET_DIR>/call-<n>/（同名输出不会互相覆盖），返回 call-<n>/<文件名>；
 * 图片由 cs-agent 在回合结束后从票据目录递归收集并随回复发送。
 */
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { classifyImageError, referenceUploads, type ImageBackend, type ImageBackendConfig } from "../agent/image-gen.js";
import { imageTimeoutMs } from "../agent/image-options.js";
import { savePendingImage, type PendingImageJob } from "../agent/image-pending.js";
import { isLoopbackUrl } from "../agent/loopback-proxy.js";
import { loadConfig } from "../config.js";
import { readImageFiles, validImageFile } from "../agent/image-files.js";
import { collectNewImages } from "../agent/image-collect.js";

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

const CALL_DIR_RE = /^call-\d+$/;

/** 新建 <dir>/call-<n>（n = 已有 call-* 目录数 + 1；已存在时继续递增），返回其路径。 */
async function nextCallDir(dir: string): Promise<string> {
  const ents = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  let n = ents.filter((e) => e.isDirectory() && CALL_DIR_RE.test(e.name)).length + 1;
  for (;;) {
    const p = path.join(dir, `call-${n}`);
    try {
      await fs.mkdir(p);
      return p;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      n++;
    }
  }
}

export interface ImageGenDeps {
  observer?: (dir: string) => import("../obs/trace.js").Trace;
  /** 原始 IMAGE_TICKET_DIR */
  ticketDir: string | undefined;
  dataDir: string;
  imageRefs?: string;
  waitMs?: number;
  imageTimeoutCapMs?: number;
  /** 惰性创建生图后端（首次调用时） */
  createBackend: () => ImageBackend;
}

const TOOLS = [
  {
    name: "generate_image",
    description:
      "用本地 ComfyUI 根据描述生成或编辑图片（最多 4 张），可设比例、尺寸、seed、负面提示词、参考图和透明背景。生成的图片会随你的回复自动发给 QQ 用户，你只需在回复里用一句话说明，不要写文件路径。提示词可以用中文。",
    inputSchema: IMAGE_OPTIONS_JSON_SCHEMA,
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
    { name: "image_gen", version: "2.0.0" },
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
    let options: ImageOptions;
    try {
      options = validateImageOptions(args);
      const allowed = (deps.imageRefs ?? '').split(',').filter(Boolean);
      imageRefsValue(allowed);
      options.reference_images = await validateReferences(options.reference_images ?? [], allowed,
        path.join(deps.dataDir, 'incoming', path.basename(dir)));
    } catch (err) { return text('生图参数无效：' + (err as Error).message, true); }
    if (calls >= MAX_CALLS) return text(`本次回复最多生成 ${MAX_CALLS} 次图片，已达上限。`, true);
    calls++;
    // 每次调用一个新子目录 call-<n>：同名输出（如 ComfyUI_00001_.png）不会覆盖上一次的结果
    const callDir = await nextCallDir(dir);
    const submission = { filenamePrefix: "cs-" + randomUUID(), referenceSubfolder: path.basename(dir) + "-" + path.basename(callDir) };
    const uploads = referenceUploads(options, submission.referenceSubfolder);
    const manifest = path.join(callDir, "remote-uploads.json");
    let done = false;
    let job: PendingImageJob | undefined;
    let promptId: string | undefined;
    const submittedAt = Date.now();
    try {
      backend ??= observeImages(deps.createBackend(), path.basename(dir), deps.observer?.(dir));
      job = { backend: backend.name, filenamePrefix: submission.filenamePrefix, options, callDir, submittedAt, status: "intent" };
      await savePendingImage(dir, job);
      if (uploads.length) await fs.writeFile(manifest, JSON.stringify(uploads), "utf8");
      const signal = AbortSignal.timeout(Math.ceil(imageTimeoutMs(options, Math.min(deps.imageTimeoutCapMs ?? 300_000, deps.waitMs ?? 90_000))));
      promptId = await backend.submit(options, submission, signal);
      job.prompt_id = promptId; job.status = "submitted";
      await savePendingImage(dir, job);
      await backend.collect(promptId, callDir, signal, options);
      const files = await readImageFiles(callDir);
      if (!(await collectNewImages(callDir, new Set())).length || (files && (files.some(f => !f.downloaded) ||
          !(await Promise.all(files.map(f => validImageFile(path.join(callDir, f.filename))))).every(Boolean)))) throw new Error("未完整收取有效图片");
      job.status = "done"; job.remoteTerminal = true;
      await savePendingImage(dir, job);
      done = true;
    } catch (err) {
      const kind = classifyImageError(err);
      if (kind === "timeout" && promptId && backend) {
        // 保存成功后才告知模型无需重试；参考图由主进程在最终收取后清理。
        // 意图及 prompt_id 已落盘，所有非 done 条目由 lateImages 接管。
        return { ...text(`图片仍在生成（任务 ${promptId} 已提交），完成后会随回复自动发送；无需重试。`), isError: false };
      }
      process.stderr.write(`image_gen: generate failed (${kind}): ${(err as Error).message.slice(0, 300)}\n`);
      return text((err as Error).message.startsWith("透明输出未启用：") ? (err as Error).message : `${FAILURE_TEXT[kind] ?? "生图失败"}，请如实告知用户。`, true);
    } finally {
      if (done && uploads.length && backend?.clearReferences) {
        await backend.clearReferences(uploads);
        await fs.unlink(manifest);
      }
    }
    const files = (await collectNewImages(callDir, new Set())).map((f) => `${path.basename(callDir)}/${path.basename(f)}`);
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
