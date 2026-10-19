import { ContextStore } from "../../src/context/store.js";
import { mediaFixture } from "../context/media-fixture.js";
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { HttpImageBackend, McpImageBackend, type ImageBackend } from "../../src/media/gen/image-gen.js";
import { collectNewImages } from "../../src/media/gen/image-collect.js";
import { backendConfigFromEnv, createImageGenServer, MAX_CALLS, resolveTicketDir } from "../../src/mcp/image-gen-server.js";
import { FIXTURES, tmp } from "../agent/helpers.js";

import { ObsStore } from '../../src/obs/store.js';
import { Trace } from '../../src/shared/trace.js';
import { registerSecrets } from '../../src/shared/redact.js';
import { ingestImageEvents } from '../../src/media/gen/events.js';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ENTRY = path.join(ROOT, "dist", "mcp", "image-gen.js");
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
/** 假 ComfyUI HTTP：/prompt → /history → /view。 */
let comfy: HttpServer;
let comfyUrl = "";
const prompts: unknown[] = [];
const slowIds = new Set<string>();
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
        if (body.includes("SLOW")) slowIds.add(`p${prompts.length}`);
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ prompt_id: `p${prompts.length}` }));
      });
      return;
    }
    if (url.pathname.startsWith("/history/")) {
      const id = url.pathname.split("/").pop()!;
      if (slowIds.has(id)) { res.end("{}"); return; }
      const out = { [id]: { status: { completed: true }, outputs: { "9": { images: [{ filename: `${id}.png`, subfolder: "", type: "output" }] } } } };
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(out));
      return;
    }
    if (url.pathname === "/queue") {
      res.end(JSON.stringify({ queue_pending: [...slowIds].map(id => [0, id]), queue_running: [] })); return;
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
  for (const k of Object.keys(base)) if (k.startsWith("COMFY") || k === "IMAGE_TICKET_DIR" || k === "IMAGE_REFS" || k === "QQ_ACCESS") delete base[k];
  for (const [k, v] of Object.entries(env)) if (v !== undefined) base[k] = v;
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [ENTRY], env: base, stderr: "pipe" }));
  clients.push(client);
  return client;
}

const textOf = (r: unknown) => ((r as { content: { text: string }[] }).content[0]!.text);

describe("image_gen MCP over stdio (built entry, fake ComfyUI over HTTP)", () => {
  it('真实 MCP 子进程不打开损坏的观测库，prompt 由主进程注册表脱敏入库',async()=>{
    const dir=tmp('cs-imggen-spool-'),ticketDir=path.join(dir,'images','spool');
    const secret='main-registry-only-fixture';registerSecrets([secret]);
    writeFileSync(path.join(dir,'observability.sqlite'),'corrupt sentinel','utf8');
    const c=await stdioClient({DATA_DIR:dir,IMAGE_TICKET_DIR:ticketDir,COMFY_MODE:'http',COMFYUI_URL:comfyUrl,COMFY_TIMEOUT_SEC:'5',COMFY_WORKFLOW_FILE:workflowFile(dir)});
    const result=await c.callTool({name:'generate_image',arguments:{prompt:'猫 '+secret}});expect(result.isError).not.toBe(true);
    expect(readFileSync(path.join(dir,'observability.sqlite'),'utf8')).toBe('corrupt sentinel');
    const store=new ObsStore(tmp('cs-imggen-main-'));
    try {
      await ingestImageEvents(ticketDir,new Trace(store));const rows=store.events('spool');expect(rows.length).toBeGreaterThanOrEqual(4);
      expect(rows.map(e=>e.detail_json).join('')).not.toContain(secret);expect(rows[0]!.detail_json).toContain('[已隐藏]');
      expect(existsSync(path.join(ticketDir,'obs-events.jsonl'))).toBe(false);
    } finally {store.close();}
  });
  it("慢 Comfy 任务在 MCP 等待上限后返回仍在生成，并追加 pending-jobs 清单", async () => {
    const dir = tmp("cs-imggen-");
    const ticketDir = path.join(dir, "images", "slow");
    const c = await stdioClient({ DATA_DIR: dir, IMAGE_TICKET_DIR: ticketDir, IMAGE_GEN_MCP_WAIT_SEC: "1",
      COMFY_MODE: "http", COMFYUI_URL: comfyUrl, COMFY_TIMEOUT_SEC: "20" });
    const before = prompts.length;
    for (let i = 1; i <= 2; i++) {
      const r = await c.callTool({ name: "generate_image", arguments: { prompt: "SLOW 猫", aspect: "16:9", size: "1mp" } });
      expect(r.isError).toBe(false);
      expect(textOf(r)).toContain(`图片仍在生成（任务 p${before + i} 已提交）`);
      expect(textOf(r)).toContain("无需重试");
    }
    const jobs = JSON.parse(readFileSync(path.join(ticketDir, "pending-jobs.json"), "utf8"));
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({ prompt_id: `p${before + 1}`, backend: "http", callDir: path.join(ticketDir, "call-1"),
      options: { prompt: "SLOW 猫", aspect: "16:9", size: "1mp" }, submittedAt: expect.any(Number) });
    expect(jobs[0].filenamePrefix).toMatch(/^cs-/);
    expect(jobs[1].filenamePrefix).not.toBe(jobs[0].filenamePrefix);
    expect(prompts.length - before).toBe(2);
  });
  it("killing the MCP process after submit leaves a collectable marker without resubmission", async () => {
    const dir = tmp("cs-imggen-kill-"), ticketDir = path.join(dir, "images", "killed");
    const c = await stdioClient({ DATA_DIR: dir, IMAGE_TICKET_DIR: ticketDir, IMAGE_GEN_MCP_WAIT_SEC: "30",
      COMFY_MODE: "http", COMFYUI_URL: comfyUrl, COMFY_TIMEOUT_SEC: "30" });
    const before = prompts.length;
    const pending = c.callTool({ name: "generate_image", arguments: { prompt: "SLOW process-kill" } }).catch(() => undefined);
    const marker = path.join(ticketDir, "pending-jobs.json");
    await vi.waitFor(() => expect(JSON.parse(readFileSync(marker, "utf8"))[0]).toMatchObject({ status: "submitted", prompt_id: expect.any(String) }));
    const job = JSON.parse(readFileSync(marker, "utf8"))[0];
    await c.close(); await pending;
    expect(JSON.parse(readFileSync(marker, "utf8"))[0].status).toBe("submitted");
    slowIds.delete(job.prompt_id);
    const files = await new HttpImageBackend({ baseUrl: comfyUrl, timeoutMs: 1000 }).collect(job.prompt_id, job.callDir, undefined, job.options);
    expect(files).toHaveLength(1); expect(prompts.length - before).toBe(1);
  });

  it("stdio 的 QQ_ACCESS 允许本域媒体，拒绝跨域、缺失权限和非媒体文件", async () => {
    const dir = tmp(), store = new ContextStore(dir);
    const media = await mediaFixture(store, dir); store.close();
    const env = { DATA_DIR: dir, COMFY_MODE: "http", COMFYUI_URL: comfyUrl, COMFY_TIMEOUT_SEC: "5" };
    for (const [index, access] of ["group:7", "all", "group:8", undefined, "invalid"].entries()) {
      const c = await stdioClient({ ...env, QQ_ACCESS: access, IMAGE_TICKET_DIR: path.join(dir, "images", "media-" + index) });
      const result = await c.callTool({ name: "generate_image", arguments: { prompt: "编辑", reference_images: [media] } });
      expect(result.isError === true).toBe(index > 1);
    }
    const c = await stdioClient({ ...env, QQ_ACCESS: "all", IMAGE_TICKET_DIR: path.join(dir, "images", "outside") });
    const outside = path.join(dir, "outside.png"); writeFileSync(outside, PNG);
    const result = await c.callTool({ name: "generate_image", arguments: { prompt: "编辑", reference_images: [outside] } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("范围");
  });

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
    expect(readdirSync(ticketDir)).toEqual(["call-1", "obs-events.jsonl", "pending-jobs.json"]);
    expect(JSON.parse(readFileSync(path.join(ticketDir, "pending-jobs.json"), "utf8"))[0].status).toBe("done");
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
  it.each([
    { waitMs: undefined, cap: undefined, size: "1mp", expected: 90_000 },
    { waitMs: 200_000, cap: undefined, size: "1mp", expected: 120_000 },
    { waitMs: 200_000, cap: 20_000, size: "2mp", expected: 20_000 },
  ] as const)("MCP 等待采用参数、后端和 MCP 上限的最小值 $expected ms", async ({ waitMs, cap, size, expected }) => {
    const dir = tmp("cs-imggen-");
    const timer = vi.spyOn(AbortSignal, "timeout");
    const backend: ImageBackend = { name: "fake", selfCheck: async () => ({}), submit: async () => "slow",
      collect: async () => { throw new Error("生图超时"); }, reconcile: async () => ({ images: [] }),
      generate: async () => [], close: async () => {} };
    const { server, dispose } = createImageGenServer({ dataDir: dir, ticketDir: path.join(dir, "images", "budget"),
      waitMs, imageTimeoutCapMs: cap, createBackend: () => backend });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" });
    await server.connect(a); await client.connect(b);
    try {
      expect((await client.callTool({ name: "generate_image", arguments: { prompt: "慢图", size } })).isError).toBe(false);
      expect(timer).toHaveBeenCalledWith(expected);
    } finally { timer.mockRestore(); await client.close(); await dispose(); }
  });

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
      expect(JSON.parse(readFileSync(path.join(dir, "images", "t2", "pending-jobs.json"), "utf8"))[0].status).toBe("intent");
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
