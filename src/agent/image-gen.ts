/**
 * 生图实现（生图任务、image_gen MCP 共用）：默认经 comfy-mcp（stdio MCP）调用 generate_image(wait=false) → job(wait) → fetch_outputs；
 * COMFY_MODE=http 时直连 ComfyUI HTTP API（POST /prompt → /history → /view）。
 * 提交与收取分开（submit 返回 prompt_id；collect 按 prompt_id 等待并下载输出）：生图任务在两步之间提交检查点，
 * 崩溃恢复时只按已记录的 prompt_id 收取，不重复提交；服务端不认识该任务时 collect 抛 UnknownJobError。
 */
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { log } from "../log.js";

export interface ImageBackend {
  readonly name: string;
  selfCheck(): Promise<Record<string, unknown>>;
  /** 提交生图任务，返回 prompt_id（不等待完成） */
  submit(prompt: string, signal?: AbortSignal): Promise<string>;
  /** 按 prompt_id 等待完成并把输出下载到 outDir；返回其中的图片。服务端不认识该任务 → UnknownJobError */
  collect(promptId: string, outDir: string, signal?: AbortSignal): Promise<string[]>;
  /** submit + collect（image_gen MCP 用） */
  generate(prompt: string, outDir: string, signal?: AbortSignal): Promise<string[]>;
  close(): Promise<void>;
}

/** 服务端报告不认识该 prompt_id（例如 ComfyUI 重启后丢失了队列）：调用方可决定重新提交一次。 */
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
export function patchWorkflow(wf: ApiWorkflow, prompt: string, seed: number, promptNode?: string): ApiWorkflow {
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
  return copy;
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
  /** API 格式工作流；设置后用 run_workflow 代替 generate_image 的默认模板 */
  workflowFile?: string;
  promptNode?: string;
}

export class McpImageBackend implements ImageBackend {
  readonly name = "mcp";
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
    return { backend: this.name, tools: [...this.schemas.keys()].length, ...info };
  }

  async generate(prompt: string, outDir: string, signal?: AbortSignal): Promise<string[]> {
    return this.collect(await this.submit(prompt, signal), outDir, signal);
  }

  async submit(prompt: string, signal?: AbortSignal): Promise<string> {
    const sig = timeoutSignal(this.opts.timeoutMs, signal);
    await this.connect(); // 先拿到工具 schema，args() 依赖它
    let submitted: Record<string, unknown>;
    let tmpDir: string | undefined;
    if (this.opts.workflowFile) {
      const wf = patchWorkflow(await loadWorkflow(this.opts.workflowFile), prompt, randomSeed(), this.opts.promptNode);
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cs-wf-"));
      const wfPath = path.join(tmpDir, "workflow.json");
      await fs.writeFile(wfPath, JSON.stringify(wf));
      try {
        submitted = await this.call(
          "run_workflow",
          this.args("run_workflow", { workflow_path: { alts: ["path", "workflow"], value: wfPath }, wait: false }),
          sig,
        );
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
      }
    } else {
      submitted = await this.call(
        "generate_image",
        this.args("generate_image", {
          prompt,
          wait: false,
          ...(this.opts.checkpoint ? { checkpoint: this.opts.checkpoint } : {}),
        }),
        sig,
      );
    }
    const promptId = findString(submitted, "prompt_id") ?? findString(submitted, "job_id");
    if (!promptId) throw new Error(`提交生图任务未返回 prompt_id: ${JSON.stringify(submitted).slice(0, 300)}`);
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

  async collect(promptId: string, outDir: string, signal?: AbortSignal): Promise<string[]> {
    const deadline = Date.now() + this.opts.timeoutMs;
    const sig = timeoutSignal(this.opts.timeoutMs, signal);
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

    await fs.mkdir(outDir, { recursive: true });
    await this.callJob(
      "fetch_outputs",
      this.args("fetch_outputs", { prompt_id: id, out_dir: { alts: ["output_dir", "dest"], value: outDir } }),
      promptId,
      sig,
    );
    const files = await listImages(outDir);
    if (files.length === 0) throw new Error("fetch_outputs 没有产出图片");
    return files.slice(0, 4);
  }

  async close(): Promise<void> {
    await this.client?.close().catch(() => undefined);
    this.client = undefined;
  }
}

// ---------------------------------------------------------------- HTTP fallback

/** ComfyUI 默认 SD1.5 文生图工作流（API 格式）。 */
export function defaultWorkflow(prompt: string, checkpoint: string, seed: number): Record<string, unknown> {
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
  pollMs?: number;
  workflowFile?: string;
  promptNode?: string;
}

export class HttpImageBackend implements ImageBackend {
  readonly name = "http";
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
    return { backend: this.name, comfyui_version: stats?.system?.comfyui_version, devices: stats?.devices?.length };
  }

  private async checkpoint(signal: AbortSignal): Promise<string> {
    if (this.opts.checkpoint) return this.opts.checkpoint;
    const info = await this.json("object_info/CheckpointLoaderSimple", { signal });
    const list: unknown = info?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0];
    const first = Array.isArray(list) ? list.find((x) => typeof x === "string") : undefined;
    if (!first) throw new Error("ComfyUI 没有可用的 checkpoint");
    return first;
  }

  async generate(prompt: string, outDir: string, signal?: AbortSignal): Promise<string[]> {
    return this.collect(await this.submit(prompt, signal), outDir, signal);
  }

  async submit(prompt: string, signal?: AbortSignal): Promise<string> {
    const sig = timeoutSignal(this.opts.timeoutMs, signal);
    const seed = randomSeed();
    const workflow = this.opts.workflowFile
      ? patchWorkflow(await loadWorkflow(this.opts.workflowFile), prompt, seed, this.opts.promptNode)
      : defaultWorkflow(prompt, await this.checkpoint(sig), seed);
    const sub = await this.json("prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: workflow, client_id: randomUUID() }),
      signal: sig,
    });
    const id: string | undefined = sub?.prompt_id;
    if (!id) throw new Error(`ComfyUI /prompt 未返回 prompt_id: ${JSON.stringify(sub).slice(0, 300)}`);
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

  async collect(id: string, outDir: string, signal?: AbortSignal): Promise<string[]> {
    const sig = timeoutSignal(this.opts.timeoutMs, signal);
    let entry: any;
    for (;;) {
      sig.throwIfAborted();
      entry = await this.historyEntry(id, sig);
      if (!entry) {
        // 历史里没有：仍在队列中则继续等；队列里也没有（且再查一次历史仍没有，避免刚完成的竞态）→ 服务端不认识该任务
        if (!(await this.inQueue(id, sig)) && !(entry = await this.historyEntry(id, sig))) throw new UnknownJobError(id, "not in history or queue");
      }
      if (entry?.status?.status_str === "error") throw new Error("ComfyUI 任务执行失败");
      if (entry?.status?.completed || (entry?.outputs && Object.keys(entry.outputs).length > 0)) break;
      await new Promise((r) => setTimeout(r, this.opts.pollMs ?? 1000));
    }

    await fs.mkdir(outDir, { recursive: true });
    const files: string[] = [];
    for (const out of Object.values<any>(entry.outputs ?? {})) {
      for (const img of out?.images ?? []) {
        if (files.length >= 4) break;
        const q = new URLSearchParams({ filename: img.filename, subfolder: img.subfolder ?? "", type: img.type ?? "output" });
        const res = await fetch(this.url(`view?${q}`), { signal: sig });
        if (!res.ok) throw new Error(`ComfyUI /view HTTP ${res.status}`);
        const dest = path.join(outDir, path.basename(img.filename));
        await fs.writeFile(dest, Buffer.from(await res.arrayBuffer()));
        files.push(dest);
      }
    }
    if (files.length === 0) throw new Error("ComfyUI 没有产出图片");
    return files;
  }

  async close(): Promise<void> {}
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
  workflowFile?: string;
  promptNode?: string;
  /** comfy-mcp 子进程环境的基础（默认 process.env） */
  baseEnv?: NodeJS.ProcessEnv;
}

export function createImageBackend(c: ImageBackendConfig): ImageBackend {
  const common = { timeoutMs: c.timeoutMs, checkpoint: c.checkpoint, workflowFile: c.workflowFile, promptNode: c.promptNode };
  if (c.mode === "http") return new HttpImageBackend({ baseUrl: c.comfyUrl, ...common });
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(c.baseEnv ?? process.env)) if (v !== undefined) env[k] = v;
  Object.assign(env, { COMFYUI_URL: c.comfyUrl, COMFY_BIN: c.comfyBin });
  return new McpImageBackend({ command: c.mcpBin, env, ...common });
}
