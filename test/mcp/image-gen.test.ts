import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { McpImageBackend } from "../../src/agent/image-gen.js";
import { collectNewImages } from "../../src/agent/image-collect.js";
import { backendConfigFromEnv, createImageGenServer, MAX_CALLS, resolveTicketDir } from "../../src/mcp/image-gen-server.js";
import { FIXTURES, tmp } from "../agent/helpers.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ENTRY = path.join(ROOT, "dist", "mcp", "image-gen.js");
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

/** dist 缺失或比源码旧时先编译（stdio 测试跑的是构建产物，与容器内一致）。 */
beforeAll(() => {
  const srcs = ["src/mcp/image-gen.ts", "src/mcp/image-gen-server.ts", "src/agent/image-gen.ts", "src/agent/image-collect.ts", "src/config.ts"];
  const newest = Math.max(...srcs.map((f) => statSync(path.join(ROOT, f)).mtimeMs));
  if (existsSync(ENTRY) && statSync(ENTRY).mtimeMs >= newest) return;
  const tsc = path.join(ROOT, "node_modules", "typescript", "bin", "tsc");
  const r = spawnSync(process.execPath, [tsc, "-p", "tsconfig.json"], { cwd: ROOT, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`build failed: ${r.stdout}${r.stderr}`);
}, 120_000);

/** 假 ComfyUI HTTP：/prompt → /history → /view。 */
let comfy: HttpServer;
let comfyUrl = "";
const prompts: unknown[] = [];
beforeAll(async () => {
  comfy = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (req.method === 'POST' && url.pathname === '/upload/image') {
      const chunks: Buffer[] = []; req.on('data', c => chunks.push(c));
      req.on('end', async () => {
        const form = await new Response(Buffer.concat(chunks), { headers: { 'content-type': req.headers['content-type']! } }).formData();
        res.end(JSON.stringify({ name: (form.get('image') as File).name, subfolder: form.get('subfolder'), type: 'input' }));
      }); return;
    }
    if (req.method === "POST" && url.pathname === "/prompt") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        prompts.push(JSON.parse(body).prompt);
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ prompt_id: `p${prompts.length}` }));
      });
      return;
    }
    if (url.pathname.startsWith("/history/")) {
      const id = url.pathname.split("/").pop()!;
      const out = { [id]: { status: { completed: true }, outputs: { "9": { images: [{ filename: `${id}.png`, subfolder: "", type: "output" }] } } } };
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(out));
      return;
    }
    if (url.pathname === "/view") {
      res.writeHead(200, { "Content-Type": "image/png" }).end(PNG);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => comfy.listen(0, "127.0.0.1", () => r()));
  comfyUrl = `http://127.0.0.1:${(comfy.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => comfy.close(() => r())));

const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => undefined)));
});

function workflowFile(dir: string): string {
  const f = path.join(dir, "wf.json");
  writeFileSync(f, JSON.stringify({ "3": { class_type: "KSampler", inputs: { seed: 1 } }, "4": { class_type: "CLIPTextEncode", inputs: { text: "x" } }, "9": { class_type: "SaveImage", inputs: { filename_prefix: "test" } } }));
  return f;
}

async function stdioClient(env: Record<string, string | undefined>): Promise<Client> {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) base[k] = v;
  for (const k of Object.keys(base)) if (k.startsWith("COMFY") || k === "IMAGE_TICKET_DIR" || k === "IMAGE_REFS") delete base[k];
  for (const [k, v] of Object.entries(env)) if (v !== undefined) base[k] = v;
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [ENTRY], env: base, stderr: "pipe" }));
  clients.push(client);
  return client;
}

const textOf = (r: unknown) => ((r as { content: { text: string }[] }).content[0]!.text);

describe("image_gen MCP over stdio (built entry, fake ComfyUI over HTTP)", () => {
  it("lists generate_image as a non-read-only tool", async () => {
    const dir = tmp("cs-imggen-");
    const c = await stdioClient({ DATA_DIR: dir, IMAGE_TICKET_DIR: path.join(dir, "images", "t1") });
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name)).toEqual(["generate_image"]);
    expect(tools[0]!.annotations).toMatchObject({ readOnlyHint: false });
    expect(Object.keys(tools[0]!.inputSchema.properties!)).toEqual(['prompt','negative_prompt','aspect','size','count','seed','reference_images','transparent']);
    expect(tools[0]!.inputSchema.additionalProperties).toBe(false);
  });

  it("generates into IMAGE_TICKET_DIR and returns the file names", async () => {
    const dir = tmp("cs-imggen-");
    const ticketDir = path.join(dir, "images", "tkt_1");
    const c = await stdioClient({
      DATA_DIR: dir, IMAGE_TICKET_DIR: ticketDir,
      COMFY_MODE: "http", COMFYUI_URL: comfyUrl, COMFY_WORKFLOW_FILE: workflowFile(dir), COMFY_PROMPT_NODE: "4", COMFY_TIMEOUT_SEC: "20",
    });
    const before = prompts.length;
    const r = await c.callTool({ name: "generate_image", arguments: { prompt: "一只橘猫" } });
    expect(r.isError).toBeFalsy();
    const files = JSON.parse(textOf(r)).files as string[];
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^call-1\/[^/]+\.png$/);
    expect(readdirSync(ticketDir)).toEqual(["call-1"]);
    expect(readFileSync(path.join(ticketDir, files[0]!)).subarray(0, 8)).toEqual(PNG.subarray(0, 8));
    expect((prompts[before] as Record<string, { inputs: { text?: string } }>)["4"]!.inputs.text).toBe("一只橘猫");
  });

  it('stdio IMAGE_REFS 允许列表仅能选择本票据文件，合法图片上传后进入编辑图', async () => {
    const dir = tmp('cs-imggen-'); const ticket = 'refs'; const refsDir = path.join(dir, 'incoming', ticket);
    mkdirSync(refsDir, { recursive: true }); const allowed = path.join(refsDir, '1.png'); const denied = path.join(refsDir, '2.png');
    writeFileSync(allowed, PNG); writeFileSync(denied, PNG);
    const c = await stdioClient({ DATA_DIR: dir, IMAGE_TICKET_DIR: path.join(dir, 'images', ticket), IMAGE_REFS: allowed,
      COMFY_MODE: 'http', COMFYUI_URL: comfyUrl, COMFY_TIMEOUT_SEC: '20' });
    for (const args of [{ prompt: '猫', reference_images: [denied] }, { prompt: '猫', count: 5 }, { prompt: '猫', unlisted: true }]) {
      expect((await c.callTool({ name: 'generate_image', arguments: args })).isError).toBe(true);
    }
    const before = prompts.length;
    const ok = await c.callTool({ name: 'generate_image', arguments: { prompt: '改红色', reference_images: [allowed], aspect: '16:9', count: 2, seed: 7 } });
    expect(ok.isError, textOf(ok)).toBeFalsy();
    const graph = prompts[before] as any;
    expect(graph['20'].inputs.image).toBe('refs-call-1/1.png');
    expect(graph['5'].inputs).toEqual({ samples: ['4',2], amount: 2 });
    expect(graph['6'].inputs.seed).toBe(7);
  });

  it("refuses without IMAGE_TICKET_DIR", async () => {
    const dir = tmp("cs-imggen-");
    const c = await stdioClient({ DATA_DIR: dir, COMFY_MODE: "http", COMFYUI_URL: comfyUrl });
    const r = await c.callTool({ name: "generate_image", arguments: { prompt: "x" } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/IMAGE_TICKET_DIR 未设置/);
  });

  it("refuses a dir outside ${DATA_DIR}/images", async () => {
    const dir = tmp("cs-imggen-");
    for (const bad of [path.join(dir, "elsewhere"), path.join(dir, "images"), path.join(dir, "images", "a", "b"), path.join(dir, "images", "..", "codex")]) {
      const c = await stdioClient({ DATA_DIR: dir, IMAGE_TICKET_DIR: bad, COMFY_MODE: "http", COMFYUI_URL: comfyUrl });
      const r = await c.callTool({ name: "generate_image", arguments: { prompt: "x" } });
      expect(r.isError, bad).toBe(true);
      expect(textOf(r)).toMatch(/image_gen 不可用/);
    }
  });
});

describe("image_gen server with the fake comfy-mcp fixture (in-memory transport)", () => {
  async function connect(dataDir: string, ticketDir: string | undefined) {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    const { server, dispose } = createImageGenServer({
      ticketDir,
      dataDir,
      createBackend: () => new McpImageBackend({ command: process.execPath, args: [path.join(FIXTURES, "fake-comfy-mcp.mjs")], env: { ...env, COMFYUI_URL: "http://comfy.test" }, timeoutMs: 20_000 }),
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: "t", version: "0" });
    await client.connect(b);
    clients.push(client);
    return { client, dispose };
  }

  it("each call writes into its own call-<n> subdir: same-named outputs are all kept and counted; MAX_CALLS enforced (R9)", async () => {
    const dir = tmp("cs-imggen-");
    const ticketDir = path.join(dir, "images", "t9");
    mkdirSync(ticketDir, { recursive: true });
    writeFileSync(path.join(ticketDir, "old.png"), PNG);
    const { client, dispose } = await connect(dir, ticketDir);
    try {
      const r = await client.callTool({ name: "generate_image", arguments: { prompt: "a dog" } });
      expect(JSON.parse(textOf(r)).files).toEqual(["call-1/ComfyUI_00001_.png"]);
      // 假 comfy-mcp 每次都输出同名 ComfyUI_00001_.png：分目录后每次都是新文件
      for (let i = 2; i <= MAX_CALLS; i++) {
        const again = await client.callTool({ name: "generate_image", arguments: { prompt: "again" } });
        expect(again.isError).toBeFalsy();
        expect(JSON.parse(textOf(again)).files).toEqual([`call-${i}/ComfyUI_00001_.png`]);
      }
      const all = await collectNewImages(ticketDir, new Set(["old.png"]), 10);
      expect(all).toHaveLength(MAX_CALLS);
      const over = await client.callTool({ name: "generate_image", arguments: { prompt: "too many" } });
      expect(over.isError).toBe(true);
      expect(textOf(over)).toMatch(/上限/);
    } finally {
      await dispose();
    }
  });

  it("a comfy-mcp tool error is reported as a failure category", async () => {
    const dir = tmp("cs-imggen-");
    const { client, dispose } = await connect(dir, path.join(dir, "images", "t2"));
    try {
      const r = await client.callTool({ name: "generate_image", arguments: { prompt: "FAIL please" } });
      expect(r.isError).toBe(true);
      expect(textOf(r)).toMatch(/生图失败/);
    } finally {
      await dispose();
    }
  });
});

describe("resolveTicketDir / backendConfigFromEnv", () => {
  it("accepts only a direct child of ${DATA_DIR}/images and rejects symlink escapes", async () => {
    const dir = tmp("cs-imggen-");
    const ok = await resolveTicketDir(path.join(dir, "images", "abc-1_2"), dir);
    expect(path.basename(ok)).toBe("abc-1_2");
    await expect(resolveTicketDir(undefined, dir)).rejects.toThrow(/未设置/);
    await expect(resolveTicketDir("relative/images/x", dir)).rejects.toThrow(/绝对路径/);
    await expect(resolveTicketDir(path.join(dir, "images", "a b"), dir)).rejects.toThrow(/票据目录/);
    if (process.platform !== "win32") {
      mkdirSync(path.join(dir, "outside"));
      symlinkSync(path.join(dir, "outside"), path.join(dir, "images", "link"));
      await expect(resolveTicketDir(path.join(dir, "images", "link"), dir)).rejects.toThrow(/不在图片目录内/);
    }
  });

  it("mcp mode with a non-loopback COMFYUI_URL goes through the main process's loopback proxy", () => {
    expect(backendConfigFromEnv({ COMFY_MODE: "mcp", COMFYUI_URL: "http://host.docker.internal:8188", COMFY_LOOPBACK_PORT: "8188" }).comfyUrl)
      .toBe("http://127.0.0.1:8188");
    expect(backendConfigFromEnv({ COMFY_MODE: "mcp", COMFYUI_URL: "http://127.0.0.1:9000" }).comfyUrl).toBe("http://127.0.0.1:9000");
    expect(backendConfigFromEnv({ COMFY_MODE: "http", COMFYUI_URL: "http://host.docker.internal:8188" }).comfyUrl)
      .toBe("http://host.docker.internal:8188");
    const c = backendConfigFromEnv({ DATA_DIR: "/data", COMFY_TIMEOUT_SEC: "120" });
    expect(c).toMatchObject({ mode: "mcp", timeoutMs: 120_000, workflowFile: undefined });
  });
});
