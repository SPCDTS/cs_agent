import { ContextStore } from "../context/store.js";
import type { Access } from "../context/access.js";
import { observeImages } from "../media/gen/observed.js";
import { IMAGE_OPTIONS_JSON_SCHEMA, validateImageOptions, type ImageOptions } from "../media/gen/image-options.js";
import { imageRefsValue } from "../media/gen/image-references.js";
import { validateReferencesWithMedia } from "../context/image-references.js";
/**
 * image_gen MCP 服务（设计 §4.4、§5.3）：供容器内 codex 生图，复用 src/media/gen/image-gen.ts 的同一实现。
 * 每个会话线程一个进程、跨回合复用：输出目录、参考图允许列表与读取范围每次调用按 _meta 向主进程求取（本会话
 * ${DATA_DIR}/images/<会话>、本轮输入的参考图、本轮发送者的范围），调用不属于会话当前回合时主进程拒绝。
 * 工具参数里不接受输出路径（参考图接受本轮输入的图或当前访问范围内的媒体库路径）；目录不在 ${DATA_DIR}/images/ 的直接子目录时拒绝。
 * 每次调用输出到新的子目录 <会话目录>/call-<n>/（同名输出不会互相覆盖），返回 call-<n>/<文件名>，由模型用 send_message 发送；
 * 等待超时的任务留在会话目录的清单里，由 cs-agent 在回合结束时补收。
 */
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { classifyImageError, referenceUploads, type ImageBackend, type ImageBackendConfig } from "../media/gen/image-gen.js";
import { imageTimeoutMs } from "../media/gen/image-options.js";
import { savePendingImage, type PendingImageJob } from "../media/gen/image-pending.js";
import { isLoopbackUrl } from "../agent/loopback-proxy.js";
import { loadAgentConfig as loadConfig } from "../agent/config.js";
import { readImageFiles, validImageFile } from "../media/gen/image-files.js";
import { collectNewImages } from "../media/gen/image-collect.js";
import type { CallMeta } from "../context/media-recall-server.js";
import { callMetaOf } from "./media-recall-client.js";

/** 每个回合最多生图次数；回复最多附带 4 张 */
export const MAX_CALLS = 4;

const TICKET_SEGMENT_RE = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * 校验会话生图目录：绝对路径、不含 ".."、规范化后恰为 ${dataDir}/images/<段> 且段只含 [A-Za-z0-9_-]；
 * 创建目录后再用 realpath 确认仍在图片根目录内（防软链接）。返回目录 realpath，否则抛出说明原因的错误。
 */
export async function resolveTicketDir(raw: string | undefined, dataDir: string): Promise<string> {
  const v = (raw ?? "").trim();
  if (!v) throw new Error("生图目录未设置");
  if (!path.isAbsolute(v) || v.split(/[\\/]/).includes("..")) throw new Error("生图目录必须是不含 .. 的绝对路径");
  const root = path.resolve(dataDir, "images");
  const dir = path.resolve(v);
  const rel = path.relative(root, dir);
  if (!rel || rel.includes("/") || rel.includes("\\") || !TICKET_SEGMENT_RE.test(rel)) {
    throw new Error("生图目录必须是 ${DATA_DIR}/images/ 下的会话目录");
  }
  await fs.mkdir(dir, { recursive: true });
  const realRoot = await fs.realpath(root);
  const realDir = await fs.realpath(dir);
  if (path.relative(realRoot, realDir) !== rel) throw new Error("生图目录解析后不在图片目录内");
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

/** 主进程求出的本次调用上下文 */
export interface ImageCallContext {
  /** 本会话的生图目录（原始路径，经 resolveTicketDir 校验） */
  dir: string;
  /** 本轮输入的参考图 */
  refs: string[];
  access?: Access;
  turnId: string;
}

export interface ImageGenDeps {
  observer?: (dir: string) => import("../shared/trace.js").Trace;
  /** 本次调用的上下文（抛错时调用返回错误文本） */
  context(meta: CallMeta): Promise<ImageCallContext>;
  dataDir: string;
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
  let store: ContextStore | undefined;
  /** 回合 → 已生图次数（有界） */
  const calls = new Map<string, number>();
  let chain: Promise<unknown> = Promise.resolve();
  const server = new Server(
    { name: "image_gen", version: "2.0.0" },
    { capabilities: { tools: {} }, instructions: "generate_image 生成的图片会随回复自动发给用户；回复只需一句说明。" },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS.map((t) => ({ ...t })) as never }));

  const generate = async (args: Record<string, unknown>, meta: CallMeta): Promise<CallToolResult> => {
    let dir: string, context: ImageCallContext;
    try {
      context = await deps.context(meta);
      dir = await resolveTicketDir(context.dir, deps.dataDir);
    } catch (err) {
      return text(`image_gen 不可用：${(err as Error).message}。`, true);
    }
    let options: ImageOptions;
    try {
      options = validateImageOptions(args);
      const allowed = context.refs;
      imageRefsValue(allowed);
      // 输出目录按会话；本轮附件各在其输入的 incoming/<入站键> 目录内，逐张按所在目录校验。
      const refs: string[] = [];
      for (const file of options.reference_images ?? []) {
        const key = path.relative(path.join(deps.dataDir, 'incoming'), path.resolve(file)).split(/[\\/]/)[0] ?? '';
        refs.push(...await validateReferencesWithMedia([file], allowed,
          path.join(deps.dataDir, 'incoming', /^[A-Za-z0-9_-]{1,128}$/.test(key) ? key : 'none'), { dataDir: deps.dataDir, access: context.access,
            openStore: () => store ??= new ContextStore(deps.dataDir, { readOnly: true }) }));
      }
      options.reference_images = refs;
    } catch (err) { return text('生图参数无效：' + (err as Error).message, true); }
    const used = calls.get(context.turnId) ?? 0;
    if (used >= MAX_CALLS) return text(`本次回复最多生成 ${MAX_CALLS} 次图片，已达上限。`, true);
    calls.delete(context.turnId);
    calls.set(context.turnId, used + 1);
    if (calls.size > 100) calls.delete(calls.keys().next().value!);
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
    const files = await collectNewImages(callDir, new Set());
    if (!files.length) return text("生图没有产出有效图片。", true);
    return text(JSON.stringify({ files, note: "请用 send_message 的 images 发送这些图片" }));
  };

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (req.params.name !== "generate_image") return text(`未知工具：${req.params.name}`, true);
    // 同一进程内的调用串行（同一目录的前后差集才准确）
    const meta = callMetaOf(req.params._meta);
    const run = chain.then(() => generate((req.params.arguments ?? {}) as Record<string, unknown>, meta));
    chain = run.catch(() => undefined);
    return run;
  });

  return {
    server,
    dispose: async () => {
      store?.close();
      await backend?.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    },
  };
}
