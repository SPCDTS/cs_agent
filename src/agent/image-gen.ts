/**
 * 生图实现（生图任务、image_gen MCP 共用）：默认经 comfy-mcp（stdio MCP）调用 run_workflow(wait=false) → job(wait) → fetch_outputs；
 * COMFY_MODE=http 时直连 ComfyUI HTTP API（POST /prompt → /history → /view）。
 * 提交与收取分开（submit 返回 prompt_id；collect 按 prompt_id 等待并下载输出）：生图任务在两步之间提交检查点，
 * 崩溃恢复时只按已记录的 prompt_id 收取，不重复提交；服务端不认识该任务时 collect 抛 UnknownJobError。
 */
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { imageTimeoutMs, validateImageOptions, type ImageOptions } from "./image-options.js";
import { buildQwenWorkflow, QWEN_MODELS, type QwenModels } from "./qwen-workflow.js";
import { validateImageHeader } from '../qq/image-header.js';
import { loadImage } from "../qq/image.js";
import { prepareImageFiles, saveImageFile, atomicJson } from "./image-files.js";
import { readPendingImages } from "./image-pending.js";
import { log } from "../log.js";

export interface ImageBackend {
  readonly name: string;
  selfCheck(): Promise<Record<string, unknown>>;
  /** 提交生图任务，返回 prompt_id（不等待完成） */
  submit(input: ImageOptions, options?: ImageSubmission, signal?: AbortSignal): Promise<string>;
  /** 按 prompt_id 等待完成并把输出下载到 outDir；返回其中的图片。服务端不认识该任务 → UnknownJobError */
  collect(promptId: string, outDir: string, signal?: AbortSignal, input?: ImageOptions): Promise<string[]>;
  /** 用输出前缀经 HTTP 对账；每个查询前后都通知调用方持久化进度。 */
  reconcile(options: ImageSubmission, outDir: string, signal?: AbortSignal, onStep?: ReconcileProgress): Promise<ReconciledImage>;
  /** submit + collect（image_gen MCP 用） */
  generate(input: ImageOptions, outDir: string, signal?: AbortSignal): Promise<string[]>;
  clearReferences?(uploads: readonly RemoteUpload[]): Promise<void>;
  close(): Promise<void>;
}

export type RemoteUpload = { name: string; subfolder: string };
export const TRANSPARENT_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=', 'base64');
export function referenceUploads(input: ImageOptions, subfolder: string): RemoteUpload[] {
  return (input.reference_images ?? []).map(file => ({ name: path.basename(file), subfolder }));
}

/** MCP 独立进程的 write-ahead 清单；主进程恢复时也会重做覆盖。 */
export async function recoverRemoteUploads(root: string, backend: Pick<ImageBackend, 'clearReferences'>): Promise<void> {
  if (!backend.clearReferences) return;
  // 未确认远端终态的参考图不得被票据清理覆盖；坏清单同样保守保留。
  const pending = await readPendingImages(root).catch(() => undefined);
  if (!pending || (await fs.readdir(root).catch(() => [] as string[])).some(name => name.startsWith("pending-jobs.json.bad-"))) return;
  const protectedDirs = new Set(pending.filter(j => !j.remoteTerminal && j.status !== "done").map(j => path.resolve(j.callDir)));
  for (const ent of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
    const file = path.join(root, ent.name);
    if (ent.isDirectory() && !ent.isSymbolicLink() && !protectedDirs.has(path.resolve(file))) await recoverRemoteUploads(file, backend);
    else if (ent.isFile() && ent.name === 'remote-uploads.json') {
      await backend.clearReferences(JSON.parse(await fs.readFile(file, 'utf8')));
      await fs.unlink(file);
    }
  }
}

async function generateWithCleanup(backend: ImageBackend, input: ImageOptions, outDir: string, signal?: AbortSignal): Promise<string[]> {
  const opts = validateImageOptions(input);
  const submission = { filenamePrefix: 'cs-' + randomUUID(), referenceSubfolder: path.basename(path.dirname(outDir)) + '-' + path.basename(outDir) };
  const uploads = referenceUploads(opts, submission.referenceSubfolder);
  await fs.mkdir(outDir, { recursive: true });
  const manifest = path.join(outDir, 'remote-uploads.json');
  if (uploads.length) await fs.writeFile(manifest, JSON.stringify(uploads), 'utf8');
  try { return await backend.collect(await backend.submit(opts, submission, signal), outDir, signal, opts); }
  finally {
    if (uploads.length) { await backend.clearReferences!(uploads); await fs.unlink(manifest); }
  }
}

export type ImageSubmission = { filenamePrefix: string; count?: number; imageOptions?: ImageOptions; referenceSubfolder?: string };
export type ReconcileStep = {
  step: "history" | "queue" | "probe";
  status: "started" | "matched" | "empty";
  prompt_id?: string;
  filenames?: string[];
};
export type ReconcileProgress = (step: ReconcileStep) => Promise<void>;
export type ReconciledImage = { prompt_id?: string; images: string[] };

export const imageFilenamePrefix = (ticket: string, attempt: number) => `cs-${ticket.slice(0, 12)}-${attempt}`;

/** 服务端报告不认识该 prompt_id；调用方必须先按输出前缀对账，不能据此认定未运行。 */
export class UnknownJobError extends Error {
  constructor(readonly promptId: string, detail = "") {
    super(`ComfyUI 不认识生图任务 ${promptId}${detail ? `: ${detail}` : ""}`);
  }
}

/** "任务不存在" 的特征（comfy-cli 的 job_not_found / download_job_not_found 等）；不匹配泛化的 "not found"（如模型文件缺失） */
const UNKNOWN_JOB_RE = /(job|prompt)[\s_-]?(id[\s_-]?)?not[\s_-]?found|unknown[\s_-](prompt|job)|no such (prompt|job)|^(not[\s_-]?found|unknown)$/i;

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

export async function listImages(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string) => {
    for (const ent of await fs.readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) await walk(p);
      else if (IMAGE_EXT.has(path.extname(ent.name).toLowerCase())) out.push(p);
    }
  };
  await walk(dir);
  return out.sort();
}

function timeoutSignal(ms: number, signal?: AbortSignal): AbortSignal {
  const t = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([t, signal]) : t;
}

// ---------------------------------------------------------------- workflow file

type ApiWorkflow = Record<string, { class_type?: string; inputs?: Record<string, unknown>; _meta?: unknown }>;

/**
 * 把提示词写入 API 格式工作流：promptNode 指定时写该节点；否则取第一个 class_type 含 "TextEncode"
 * 且有字符串 prompt/text 输入的节点（跳过标题含 negative 的节点）。随机化所有数值 seed / noise_seed。
 */
export function patchWorkflow(wf: ApiWorkflow, prompt: string, seed: number, promptNode?: string, filenamePrefix?: string): ApiWorkflow {
  const copy: ApiWorkflow = JSON.parse(JSON.stringify(wf));
  const isNegative = (n: ApiWorkflow[string]) => /negative/i.test(JSON.stringify(n._meta ?? ""));
  const id =
    promptNode ||
    Object.keys(copy).find((k) => {
      const n = copy[k]!;
      const ins = n.inputs ?? {};
      return /TextEncode/i.test(n.class_type ?? "") && !isNegative(n) && (typeof ins.prompt === "string" || typeof ins.text === "string");
    });
  const node = id ? copy[id] : undefined;
  if (!node?.inputs) throw new Error("工作流中找不到提示词节点（可设置 COMFY_PROMPT_NODE）");
  if (typeof node.inputs.prompt === "string") node.inputs.prompt = prompt;
  else node.inputs.text = prompt;
  for (const n of Object.values(copy)) {
    for (const key of ["seed", "noise_seed"]) if (typeof n.inputs?.[key] === "number") n.inputs[key] = seed;
  }
  if (filenamePrefix) patchFilenamePrefix(copy, filenamePrefix);
  return copy;
}

function patchFilenamePrefix(wf: ApiWorkflow, prefix: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(prefix)) throw new Error("非法的图片文件名前缀");
  const saves = Object.values(wf).filter(n => /^(SaveImage|SaveImageAdvanced)$/.test(n.class_type ?? "") && n.inputs);
  if (!saves.length) throw new Error("工作流中找不到 SaveImage 节点，无法记录输出前缀");
  for (const n of saves) n.inputs!.filename_prefix = prefix;
}

export async function loadWorkflow(file: string): Promise<ApiWorkflow> {
  const wf = JSON.parse(await fs.readFile(file, "utf8"));
  if (!wf || typeof wf !== "object" || Array.isArray(wf.nodes)) throw new Error(`${file} 不是 API 格式工作流`);
  return wf as ApiWorkflow;
}

const randomSeed = () => Math.floor(Math.random() * 2 ** 31);

// ---------------------------------------------------------------- MCP

type ToolResult = { content?: unknown; structuredContent?: unknown; isError?: boolean };

/** 把 MCP 工具结果解析为对象：优先 structuredContent（FastMCP 包一层 result），其次首个 JSON 文本块。 */
export function parseToolResult(r: ToolResult): Record<string, unknown> {
  let v: unknown = r.structuredContent;
  if (v && typeof v === "object" && "result" in (v as object) && Object.keys(v as object).length === 1) {
    v = (v as { result: unknown }).result;
  }
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  const blocks = Array.isArray(r.content) ? (r.content as { type?: string; text?: string }[]) : [];
  for (const b of blocks) {
    if (b.type === "text" && b.text) {
      try {
        const j = JSON.parse(b.text);
        if (j && typeof j === "object") return Array.isArray(j) ? { items: j } : j;
      } catch {
        return { text: b.text };
      }
    }
  }
  return {};
}

/** 在嵌套对象里找第一个名为 key 的字符串值。 */
export function findString(v: unknown, key: string, depth = 0): string | undefined {
  if (!v || typeof v !== "object" || depth > 6) return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o[key] === "string" && o[key]) return o[key] as string;
  for (const child of Object.values(o)) {
    const hit = findString(child, key, depth + 1);
    if (hit) return hit;
  }
  return undefined;
}

function resultText(r: ToolResult): string {
  const blocks = Array.isArray(r.content) ? (r.content as { type?: string; text?: string }[]) : [];
  return blocks
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("\n")
    .slice(0, 500);
}

export interface McpBackendOptions {
  command: string;
  args?: string[];
  env: Record<string, string>;
  timeoutMs: number;
  checkpoint?: string;
  models?: QwenModels;
  cache?: boolean;
  /** API 格式工作流；设置后用 run_workflow 代替 generate_image 的默认模板 */
  workflowFile?: string;
  promptNode?: string;
}

export class McpImageBackend implements ImageBackend {
  readonly name = "mcp";
  private readonly jobs = new Map<string, ImageOptions>();
  private client?: Client;
  private schemas = new Map<string, Set<string>>();
  private connecting?: Promise<Client>;

  constructor(private readonly opts: McpBackendOptions) {}

  private connect(): Promise<Client> {
    if (this.client) return Promise.resolve(this.client);
    this.connecting ??= (async () => {
      const transport = new StdioClientTransport({
        command: this.opts.command,
        args: this.opts.args ?? [],
        env: this.opts.env,
        stderr: "pipe",
      });
      transport.stderr?.on("data", (d: Buffer) => log.debug("comfy-mcp stderr", { line: d.toString().slice(0, 300) }));
      const client = new Client({ name: "cs-agent", version: "0.1.0" });
      transport.onclose = () => {
        this.client = undefined;
        this.connecting = undefined;
      };
      await client.connect(transport);
      const tools = await client.listTools();
      for (const t of tools.tools) {
        this.schemas.set(t.name, new Set(Object.keys((t.inputSchema?.properties as object) ?? {})));
      }
      this.client = client;
      return client;
    })().catch((err) => {
      this.connecting = undefined;
      throw err;
    });
    return this.connecting;
  }

  /** 只保留服务端 schema 中存在的参数名；候选名按顺序取第一个存在的。 */
  private args(tool: string, wanted: Record<string, unknown | { alts: string[]; value: unknown }>): Record<string, unknown> {
    const props = this.schemas.get(tool);
    if (!props) throw new Error(`comfy-mcp 未提供工具 ${tool}`);
    const out: Record<string, unknown> = {};
    for (const [name, v] of Object.entries(wanted)) {
      if (v && typeof v === "object" && "alts" in (v as object)) {
        const { alts, value } = v as { alts: string[]; value: unknown };
        const hit = [name, ...alts].find((n) => props.has(n));
        if (hit) out[hit] = value;
      } else if (props.has(name) || props.size === 0) {
        out[name] = v;
      }
    }
    return out;
  }

  private async call(tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const client = await this.connect();
    const r = (await client.callTool({ name: tool, arguments: args }, undefined, {
      signal,
      timeout: this.opts.timeoutMs,
    })) as ToolResult;
    if (r.isError) throw new Error(`${tool} 失败: ${resultText(r)}`);
    return parseToolResult(r);
  }

  async selfCheck(): Promise<Record<string, unknown>> {
    const info = await this.call("server_info", {});
    const check = await this.http().selfCheck().catch(() => ({ transparent: "透明输出依赖检测失败：ComfyUI 不可用" }));
    return { ...check, backend: this.name, tools: [...this.schemas.keys()].length, ...info };
  }

  async generate(input: ImageOptions, outDir: string, signal?: AbortSignal): Promise<string[]> {
    return generateWithCleanup(this, input, outDir, signal);
  }

  async clearReferences(uploads: readonly RemoteUpload[]): Promise<void> { await this.http().clearReferences(uploads); }

  private http(): HttpImageBackend {
    const baseUrl = this.opts.env.COMFYUI_URL;
    if (!baseUrl) throw new Error("COMFYUI_URL 未设置，无法对账生图输出");
    return new HttpImageBackend({ ...this.opts, baseUrl });
  }

  reconcile(options: ImageSubmission, outDir: string, signal?: AbortSignal, onStep?: ReconcileProgress): Promise<ReconciledImage> {
    return this.http().reconcile(options, outDir, signal, onStep);
  }

  async submit(input: ImageOptions, options?: ImageSubmission, signal?: AbortSignal): Promise<string> {
    const opts = validateImageOptions(input);
    const sig = timeoutSignal(imageTimeoutMs(opts, this.opts.timeoutMs), signal);
    await this.connect();
    const http = this.http();
    // upload_file 的 paths-only 版本不能指定票据子目录，此时用同 URL 的 HTTP 上传。
    const uploader = this.schemas.get('upload_file');
    const upload = uploader?.has('paths') && uploader.has('subfolder')
      ? async (file: string, subfolder: string) => {
          validateImageHeader(loadImage(file, path.dirname(file)));
          const result = await this.call('upload_file', { paths: [file], subfolder, overwrite: true }, sig);
          return uploadedName(result, subfolder);
        }
      : undefined;
    const wf = await http.submissionWorkflow(opts, sig, options, upload);
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-wf-'));
    let submitted: Record<string, unknown>;
    try {
      const wfPath = path.join(tmpDir, 'workflow.json');
      await fs.writeFile(wfPath, JSON.stringify(wf), 'utf8');
      submitted = await this.call('run_workflow', this.args('run_workflow', {
        workflow_path: { alts: ['path', 'workflow'], value: wfPath }, wait: false,
      }), sig);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
    const promptId = findString(submitted, "prompt_id") ?? findString(submitted, "job_id");
    if (!promptId) throw new Error(`提交生图任务未返回 prompt_id: ${JSON.stringify(submitted).slice(0, 300)}`);
    this.jobs.set(promptId, opts);
    log.info("comfy job submitted", { prompt_id: promptId });
    return promptId;
  }

  /** 调用一个按 prompt_id 操作的工具；服务端报告不认识该任务时转成 UnknownJobError。 */
  private async callJob(tool: string, args: Record<string, unknown>, promptId: string, signal: AbortSignal): Promise<Record<string, unknown>> {
    try {
      return await this.call(tool, args, signal);
    } catch (err) {
      if (!signal.aborted && UNKNOWN_JOB_RE.test((err as Error).message)) throw new UnknownJobError(promptId, (err as Error).message.slice(0, 200));
      throw err;
    }
  }

  async collect(promptId: string, outDir: string, signal?: AbortSignal, input?: ImageOptions): Promise<string[]> {
    const budget = imageTimeoutMs(input ?? this.jobs.get(promptId) ?? { prompt: "recovery" }, this.opts.timeoutMs);
    this.jobs.delete(promptId);
    const deadline = Date.now() + budget;
    const sig = timeoutSignal(budget, signal);
    await this.connect();
    const id = { alts: ["job_id", "id"], value: promptId };
    for (;;) {
      const left = Math.floor((deadline - Date.now()) / 1000);
      if (left <= 0) throw new Error("生图超时");
      const st = await this.callJob("job", this.args("job", { action: "wait", prompt_id: id, timeout_seconds: Math.min(left, 60) }), promptId, sig);
      if (st.timed_out === true) continue;
      const status = (findString(st, "status") ?? "").toLowerCase();
      const errText = typeof st.error === "string" ? st.error : st.error ? JSON.stringify(st.error) : "";
      if (UNKNOWN_JOB_RE.test(status) || UNKNOWN_JOB_RE.test(errText)) throw new UnknownJobError(promptId, (errText || status).slice(0, 200));
      if (/error|fail|cancel/.test(status) || st.error) {
        throw new Error(`生图任务失败: ${JSON.stringify(st.error ?? status).slice(0, 300)}`);
      }
      break;
    }

    const stage = path.join(outDir, ".download", createHash("sha256").update(promptId).digest("hex"));
    const complete = path.join(stage, "complete.json");
    await fs.mkdir(stage, { recursive: true });
    let names: string[];
    if (await fs.access(complete).then(() => true, () => false)) {
      names = JSON.parse(await fs.readFile(complete, "utf8"));
    } else {
      await this.callJob("fetch_outputs", this.args("fetch_outputs", {
        prompt_id: id, out_dir: { alts: ["output_dir", "dest"], value: stage },
      }), promptId, sig);
      names = (await listImages(stage)).map(file => path.basename(file)).slice(0, 4);
      if (!names.length) throw new Error("fetch_outputs 没有产出图片");
      await atomicJson(complete, names);
    }
    const manifest = await prepareImageFiles(outDir, names);
    for (const [index, item] of manifest.entries()) {
      sig.throwIfAborted();
      if (!item.downloaded) await saveImageFile(outDir, manifest, index, await fs.readFile(path.join(stage, item.filename)));
    }
    this.jobs.delete(promptId);
    return manifest.map(item => path.join(outDir, item.filename));
  }

  async close(): Promise<void> {
    await this.client?.close().catch(() => undefined);
    this.client = undefined;
    this.jobs.clear();
  }
}

// ---------------------------------------------------------------- HTTP fallback

/** ComfyUI 默认 SD1.5 文生图工作流（API 格式）。 */
export function defaultWorkflow(prompt: string, checkpoint: string, seed: number): ApiWorkflow {
  return {
    "3": {
      class_type: "KSampler",
      inputs: { seed, steps: 20, cfg: 7, sampler_name: "euler", scheduler: "normal", denoise: 1, model: ["4", 0], positive: ["6", 0], negative: ["7", 0], latent_image: ["5", 0] },
    },
    "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: checkpoint } },
    "5": { class_type: "EmptyLatentImage", inputs: { width: 512, height: 512, batch_size: 1 } },
    "6": { class_type: "CLIPTextEncode", inputs: { text: prompt, clip: ["4", 1] } },
    "7": { class_type: "CLIPTextEncode", inputs: { text: "lowres, bad anatomy, worst quality, low quality, watermark, text", clip: ["4", 1] } },
    "8": { class_type: "VAEDecode", inputs: { samples: ["3", 0], vae: ["4", 2] } },
    "9": { class_type: "SaveImage", inputs: { filename_prefix: "cs_agent", images: ["8", 0] } },
  };
}

export interface HttpBackendOptions {
  baseUrl: string;
  timeoutMs: number;
  checkpoint?: string;
  models?: QwenModels;
  cache?: boolean;
  pollMs?: number;
  workflowFile?: string;
  promptNode?: string;
}

export class HttpImageBackend implements ImageBackend {
  readonly name = "http";
  private readonly jobs = new Map<string, ImageOptions>();
  constructor(private readonly opts: HttpBackendOptions) {}

  private url(p: string): string {
    return new URL(p, this.opts.baseUrl.endsWith("/") ? this.opts.baseUrl : `${this.opts.baseUrl}/`).toString();
  }

  private async json(p: string, init: RequestInit = {}): Promise<any> {
    const res = await fetch(this.url(p), init);
    if (!res.ok) throw new Error(`ComfyUI ${p} HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res.json();
  }

  async selfCheck(): Promise<Record<string, unknown>> {
    const stats = await this.json("system_stats", { signal: AbortSignal.timeout(5000) });
    let transparent: string | true = true;
    try { await this.checkTransparent(AbortSignal.timeout(5000)); } catch (err) { transparent = (err as Error).message; }
    return { backend: this.name, comfyui_version: stats?.system?.comfyui_version, devices: stats?.devices?.length, transparent };
  }

  async generate(input: ImageOptions, outDir: string, signal?: AbortSignal): Promise<string[]> {
    return generateWithCleanup(this, input, outDir, signal);
  }

  async clearReferences(uploads: readonly RemoteUpload[]): Promise<void> {
    for (const { name, subfolder } of uploads) {
      if (!/^[A-Za-z0-9_-]+$/.test(subfolder) || !name || /[\\/]/.test(name) || name === '..') throw new Error('非法的远端参考图清单');
      const form = new FormData();
      form.set('image', new Blob([new Uint8Array(TRANSPARENT_PNG)]), name);
      form.set('subfolder', subfolder); form.set('type', 'input'); form.set('overwrite', 'true');
      const result = await this.json('upload/image', { method: 'POST', body: form, signal: AbortSignal.timeout(15_000) });
      if (uploadedName(result, subfolder) !== subfolder + '/' + name) throw new Error('远端参考图覆盖文件名不一致');
    }
  }

  async uploadReference(file: string, subfolder: string, signal: AbortSignal): Promise<string> {
    const bytes = loadImage(file, path.dirname(file));
    validateImageHeader(bytes);
    const form = new FormData();
    form.set('image', new Blob([new Uint8Array(bytes)]), path.basename(file));
    form.set('subfolder', subfolder);
    form.set('type', 'input');
    form.set('overwrite', 'true');
    return uploadedName(await this.json('upload/image', { method: 'POST', body: form, signal }), subfolder);
  }

  async submissionWorkflow(input: ImageOptions, signal: AbortSignal, submission?: ImageSubmission,
    upload?: (file: string, subfolder: string) => Promise<string>): Promise<ApiWorkflow> {
    const opts = validateImageOptions(input);
    const prefix = submission?.filenamePrefix ?? 'cs-' + randomUUID();
    if (this.opts.workflowFile) return patchWorkflow(await loadWorkflow(this.opts.workflowFile), opts.prompt,
      opts.seed ?? randomSeed(), this.opts.promptNode, submission?.filenamePrefix);
    const subfolder = submission?.referenceSubfolder ?? prefix;
    if (!/^[A-Za-z0-9_-]+$/.test(subfolder)) throw new Error('非法的参考图子目录');
    const refs: string[] = [];
    for (const file of opts.reference_images ?? []) {
      validateImageHeader(loadImage(file, path.dirname(file)));
      const name = await (upload ? upload(file, subfolder) : this.uploadReference(file, subfolder, signal));
      if (name !== subfolder + '/' + path.basename(file)) throw new Error('ComfyUI 上传文件名不一致');
      refs.push(name);
    }
    if (opts.transparent) await this.checkTransparent(signal);
    return buildQwenWorkflow({ ...opts, reference_images: refs }, { filenamePrefix: prefix, models: this.opts.models, cache: this.opts.cache });
  }

  private async checkTransparent(signal: AbortSignal): Promise<void> {
    const models = this.opts.models ?? QWEN_MODELS;
    const info = await this.json('object_info/VAELoader', { signal });
    const names = info?.VAELoader?.input?.required?.vae_name?.[0];
    if (!Array.isArray(names) || !names.includes(models.vae)) throw new Error('透明输出未启用：缺少 ' + models.vae);
  }

  async submit(input: ImageOptions, options?: ImageSubmission, signal?: AbortSignal): Promise<string> {
    const opts = validateImageOptions(input);
    const sig = timeoutSignal(imageTimeoutMs(opts, this.opts.timeoutMs), signal);
    const workflow = await this.submissionWorkflow(opts, sig, options);
    const sub = await this.json("prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: workflow, client_id: randomUUID() }),
      signal: sig,
    });
    const id: string | undefined = sub?.prompt_id;
    if (!id) throw new Error(`ComfyUI /prompt 未返回 prompt_id: ${JSON.stringify(sub).slice(0, 300)}`);
    this.jobs.set(id, opts);
    log.info("comfy job submitted (http)", { prompt_id: id });
    return id;
  }

  /** /queue 里是否还有该任务（运行中或排队中）。 */
  private async inQueue(id: string, signal: AbortSignal): Promise<boolean> {
    const q = await this.json("queue", { signal });
    const rows = [...(Array.isArray(q?.queue_running) ? q.queue_running : []), ...(Array.isArray(q?.queue_pending) ? q.queue_pending : [])];
    return rows.some((r: unknown) => Array.isArray(r) && r[1] === id);
  }

  private async historyEntry(id: string, signal: AbortSignal): Promise<any> {
    const hist = await this.json(`history/${encodeURIComponent(id)}`, { signal });
    return hist?.[id];
  }

  async collect(id: string, outDir: string, signal?: AbortSignal, input?: ImageOptions): Promise<string[]> {
    const sig = timeoutSignal(imageTimeoutMs(input ?? this.jobs.get(id) ?? { prompt: "recovery" }, this.opts.timeoutMs), signal);
    this.jobs.delete(id);
    let entry: any;
    for (;;) {
      sig.throwIfAborted();
      entry = await this.historyEntry(id, sig);
      if (!entry) {
        // 历史里没有：仍在队列中则继续等；队列里也没有（且再查一次历史仍没有，避免刚完成的竞态）→ 服务端不认识该任务
        if (!(await this.inQueue(id, sig)) && !(entry = await this.historyEntry(id, sig))) throw new UnknownJobError(id, "not in history or queue");
      }
      if (entry?.status?.status_str === "error") throw new Error("ComfyUI 任务执行失败");
      if (entry?.status?.completed === true || (entry?.status?.completed !== false && entry?.outputs && Object.keys(entry.outputs).length > 0)) break;
      await sleep(this.opts.pollMs ?? 1000, undefined, { signal: sig });
    }

    const files = await this.download(outputImages(entry), outDir, sig);
    if (files.length === 0) throw new Error("ComfyUI 没有产出图片");
    this.jobs.delete(id);
    return files;
  }

  private async download(images: ComfyImage[], outDir: string, signal: AbortSignal, probe = false): Promise<string[]> {
    const outputs = images.slice(0, 4);
    const manifest = await prepareImageFiles(outDir, outputs.map(img => path.basename(img.filename)));
    const files: string[] = [];
    for (const [index, img] of outputs.entries()) {
      const dest = path.join(outDir, manifest[index]!.filename);
      if (manifest[index]!.downloaded) { files.push(dest); continue; }
      const q = new URLSearchParams({ filename: img.filename, subfolder: img.subfolder ?? "", type: img.type ?? "output" });
      const res = await fetch(this.url(`view?${q}`), { signal });
      if (probe && res.status === 404) continue;
      if (!res.ok) throw new Error(`ComfyUI /view HTTP ${res.status}`);
      const bytes = Buffer.from(await res.arrayBuffer());
      await saveImageFile(outDir, manifest, index, bytes);
      files.push(dest);
    }
    return files;
  }

  async reconcile(options: ImageSubmission, outDir: string, signal?: AbortSignal, onStep?: ReconcileProgress): Promise<ReconciledImage> {
    const { filenamePrefix, count = 1 } = options;
    if (!/^[A-Za-z0-9_-]+$/.test(filenamePrefix) || !Number.isInteger(count) || count < 1 || count > 4) throw new Error("非法的生图对账参数");
    const sig = timeoutSignal(imageTimeoutMs(options.imageOptions ?? { prompt: "recovery", count }, this.opts.timeoutMs), signal);
    const history = async (): Promise<ReconciledImage | undefined> => {
      await onStep?.({ step: "history", status: "started" });
      const entries = await this.json("history", { signal: sig });
      for (const [id, entry] of Object.entries(entries)) {
        // 带下划线边界，避免 attempt=1 误匹配 attempt=10。
        const images = outputImages(entry).filter(img => img.filename.startsWith(`${filenamePrefix}_`));
        if (!images.length) continue;
        await onStep?.({ step: "history", status: "matched", prompt_id: id, filenames: images.map(img => img.filename) });
        return { prompt_id: id, images: (entry as any)?.status?.completed === false
          ? await this.collect(id, outDir, sig, options.imageOptions) : await this.download(images, outDir, sig) };
      }
      await onStep?.({ step: "history", status: "empty" });
      return undefined;
    };
    const found = await history();
    if (found) return found;
    await onStep?.({ step: "queue", status: "started" });
    const q = await this.json("queue", { signal: sig });
    const rows = [...(q.queue_running ?? []), ...(q.queue_pending ?? [])];
    const queued = rows.find((row: unknown) => Array.isArray(row) && typeof row[1] === "string" && row[2] &&
      Object.values(row[2] as ApiWorkflow).some(n => /^(SaveImage|SaveImageAdvanced)$/.test(n.class_type ?? "") && n.inputs?.filename_prefix === filenamePrefix));
    if (queued) {
      await onStep?.({ step: "queue", status: "matched", prompt_id: queued[1] });
      try {
        return { prompt_id: queued[1], images: await this.collect(queued[1], outDir, sig, options.imageOptions) };
      } catch (err) {
        // 等待期间队列/历史被清空，也必须探测输出，不能把 unknown 当成未运行。
        if (!(err instanceof UnknownJobError)) throw err;
      }
    } else {
      await onStep?.({ step: "queue", status: "empty" });
    }
    // 防止首次查历史后任务恰好出队：再查历史，随后才探测预计文件名。
    const completed = await history();
    if (completed) return completed;
    await onStep?.({ step: "probe", status: "started" });
    const expected = Array.from({ length: count }, (_, i) => ({ filename: `${filenamePrefix}_${String(i + 1).padStart(5, "0")}${options.imageOptions?.transparent ? "" : "_"}.png`, type: "output" }));
    const images = await this.download(expected, outDir, sig, true);
    await onStep?.({ step: "probe", status: images.length ? "matched" : "empty", filenames: images.map(file => path.basename(file)) });
    return { images };
  }

  async close(): Promise<void> { this.jobs.clear(); }
}

type ComfyImage = { filename: string; subfolder?: string; type?: string };
function outputImages(entry: any): ComfyImage[] {
  return Object.values<any>(entry?.outputs ?? {}).flatMap(out => Array.isArray(out?.images) ? out.images : [])
    .filter((img: any) => typeof img?.filename === "string");
}

// ---------------------------------------------------------------- 票据目录与失败分类

/** 票据对应的图片输出目录：<imagesDir>/<ticket>（非法字符替换为 _）。 */
export function ticketImageDir(imagesDir: string, ticket: string): string {
  return path.join(imagesDir, ticket.replace(/[^a-zA-Z0-9_-]/g, "_"));
}

/** 生图失败类别（决定固定回复模板）。 */
export type ImageFailure = "unavailable" | "timeout" | "refused" | "failed";

export function classifyImageError(err: unknown): ImageFailure {
  const msg = err instanceof Error ? err.message : String(err);
  if (/超时|timeout|timed out|abort/i.test(msg)) return "timeout";
  if (/ECONNREFUSED|ECONNRESET|fetch failed|ENOTFOUND|EHOSTUNREACH|connect|不可用|unavailable|ENOENT|spawn/i.test(msg)) return "unavailable";
  if (/nsfw|safety|content.?(policy|filter|blocked)|refus|拒绝|违规|敏感/i.test(msg)) return "refused";
  return "failed";
}

/** 按环境变量构造生图后端（agent 主进程与 image_gen MCP 共用同一规则）。 */
export interface ImageBackendConfig {
  mode: "mcp" | "http";
  /** http 模式直连的 ComfyUI；mcp 模式传给 comfy-mcp 的 COMFYUI_URL（须为 loopback，见 loopback-proxy.ts） */
  comfyUrl: string;
  mcpBin: string;
  comfyBin: string;
  timeoutMs: number;
  checkpoint?: string;
  models?: QwenModels;
  cache?: boolean;
  workflowFile?: string;
  promptNode?: string;
  /** comfy-mcp 子进程环境的基础（默认 process.env） */
  baseEnv?: NodeJS.ProcessEnv;
}

export function createImageBackend(c: ImageBackendConfig): ImageBackend {
  const common = { models: c.models, cache: c.cache ?? /^(1|true|yes|on)$/i.test((c.baseEnv ?? process.env).COMFY_QWEN_CACHE ?? ""), timeoutMs: c.timeoutMs, checkpoint: c.checkpoint, workflowFile: c.workflowFile, promptNode: c.promptNode };
  if (c.mode === "http") return new HttpImageBackend({ baseUrl: c.comfyUrl, ...common });
  return new McpImageBackend({ command: c.mcpBin, env: buildImageEnv(c), ...common });
}

/** MCP 子进程仅继承运行所需变量，OBS_TOKEN 不进入子进程。 */
export function buildImageEnv(c: Pick<ImageBackendConfig, "baseEnv" | "comfyUrl" | "comfyBin">): Record<string,string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(c.baseEnv ?? process.env)) if (v !== undefined && /^(PATH|HOME|USERPROFILE|SYSTEMROOT|WINDIR|TEMP|TMP|APPDATA|LOCALAPPDATA|COMSPEC|PATHEXT|LANG|LC_ALL|TZ|PYTHONUNBUFFERED|COMFY_[A-Z_]+)$/i.test(k)) env[k] = v;
  Object.assign(env, { COMFYUI_URL: c.comfyUrl, COMFY_BIN: c.comfyBin });
  return env;
}

/** 上传返回值必须仍在本票据子目录内，禁止把服务端路径直接当本机路径使用。 */
function uploadedName(result: unknown, subfolder: string): string {
  const name = findString(result, 'name');
  const folder = findString(result, 'subfolder');
  if (!name || /[\\/]/.test(name) || name === '..' || folder !== subfolder) throw new Error('ComfyUI 上传未返回票据子目录内的文件名');
  return subfolder + '/' + name;
}
