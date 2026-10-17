/**
 * 生图：默认经 comfy-mcp（stdio MCP）调用 generate_image(wait=false) → job(wait) → fetch_outputs；
 * COMFY_MODE=http 时直连 ComfyUI HTTP API（POST /prompt → /history → /view）。
 */
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { BUSINESS_ALREADY_USED, claimBusinessCall, TicketDoc } from "../docs.js";
import { log } from "../../log.js";

export interface ImageBackend {
  readonly name: string;
  selfCheck(): Promise<Record<string, unknown>>;
  generate(prompt: string, outDir: string, signal?: AbortSignal): Promise<string[]>;
  close(): Promise<void>;
}

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
    const deadline = Date.now() + this.opts.timeoutMs;
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

    for (;;) {
      const left = Math.floor((deadline - Date.now()) / 1000);
      if (left <= 0) throw new Error("生图超时");
      const st = await this.call(
        "job",
        this.args("job", { action: "wait", prompt_id: { alts: ["job_id", "id"], value: promptId }, timeout_seconds: Math.min(left, 60) }),
        sig,
      );
      if (st.timed_out === true) continue;
      const status = (findString(st, "status") ?? "").toLowerCase();
      if (/error|fail|cancel/.test(status) || st.error) {
        throw new Error(`生图任务失败: ${JSON.stringify(st.error ?? status).slice(0, 300)}`);
      }
      break;
    }

    await fs.mkdir(outDir, { recursive: true });
    await this.call(
      "fetch_outputs",
      this.args("fetch_outputs", {
        prompt_id: { alts: ["job_id", "id"], value: promptId },
        out_dir: { alts: ["output_dir", "dest"], value: outDir },
      }),
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

    let entry: any;
    for (;;) {
      sig.throwIfAborted();
      const hist = await this.json(`history/${encodeURIComponent(id)}`, { signal: sig });
      entry = hist?.[id];
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

// ---------------------------------------------------------------- tool

/** 票据对应的图片输出目录：<imagesDir>/<ticket>（非法字符替换为 _）。reply_qq 用同一规则校验。 */
export function ticketImageDir(imagesDir: string, ticket: string): string {
  return path.join(imagesDir, ticket.replace(/[^a-zA-Z0-9_-]/g, "_"));
}

export function createGenerateImageTool(backend: ImageBackend, imagesDir: string) {
  return defineTool({
    name: "generate_image",
    description: "用本地 ComfyUI 根据英文正向提示词生成图片，返回图片本地路径（随后交给 reply_qq 的 image_paths）。仅用于纯生图请求。",
    parameters: Type.Object({
      prompt: Type.String({ description: "英文正向提示词（English positive prompt）" }),
    }),
    replay: "unsafe",
    execute: async (args, api, context) => {
      if (!(await claimBusinessCall(api, "generate_image", context))) {
        return { output: [{ type: "text", text: BUSINESS_ALREADY_USED }], isError: true };
      }
      const doc = await api.snapshot(TicketDoc, api.conversationId, context);
      const ticket = doc?.ticket || `adhoc-${Date.now()}`;
      const outDir = ticketImageDir(imagesDir, ticket);
      const started = Date.now();
      try {
        const files = await backend.generate(args.prompt, outDir, context.abortSignal);
        log.info("generate_image done", { backend: backend.name, ms: Date.now() - started, files: files.length });
        // 记录本会话产出的图片（realpath），reply_qq 只允许发送这些文件
        const real = await Promise.all(files.map((f) => fs.realpath(f)));
        await api.commit(async (tx) => {
          (await tx.doc(TicketDoc, api.conversationId)).images = real;
        }, context);
        return { output: [{ type: "text", text: JSON.stringify({ image_paths: files }) }] };
      } catch (err) {
        const msg = (err as Error).message;
        log.warn("generate_image failed", { backend: backend.name, ms: Date.now() - started, error: msg });
        const kind = /超时|timeout|abort/i.test(msg) ? "生图超时" : /ECONNREFUSED|fetch failed|ENOTFOUND|connect/i.test(msg) ? "生图服务不可用" : "生图失败";
        return { output: [{ type: "text", text: `${kind}，请用一句话告知用户。` }], isError: true };
      }
    },
  });
}
