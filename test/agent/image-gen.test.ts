import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { HttpImageBackend, McpImageBackend, UnknownJobError, defaultWorkflow, parseToolResult, patchWorkflow, type ReconcileStep } from "../../src/media/gen/image-gen.js";
import { isLoopbackUrl, startLoopbackProxy } from "../../src/agent/loopback-proxy.js";
import { FIXTURES, tmp } from "./helpers.js";

const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
env.COMFYUI_URL = "http://comfy.test:8188";

const backend = new McpImageBackend({
  command: process.execPath,
  args: [path.join(FIXTURES, "fake-comfy-mcp.mjs")],
  env,
  timeoutMs: 20_000,
});
afterAll(() => backend.close());

describe("McpImageBackend (fake comfy-mcp over stdio)", () => {
  it("server_info self-check", async () => {
    const info = await backend.selfCheck();
    expect(info).toMatchObject({ backend: "mcp", running: true, url: "http://comfy.test:8188" });
  });

  it("generate_image(wait=false) → job(wait) until done → fetch_outputs into out dir", async () => {
    const out = path.join(tmp(), "images", "ticket1");
    const files = await backend.generate({ prompt: "a red fox in snow" }, out);
    expect(files).toEqual([path.join(out, "ComfyUI_00001_.png")]);
    expect(existsSync(files[0]!)).toBe(true);
    const calls = JSON.parse(readFileSync(path.join(out, ".download", createHash("sha256").update("pid-1").digest("hex"), "calls.json"), "utf8")) as [string, any][];
    expect(calls.map((c) => c[0])).toEqual(["run_workflow", "job", "job", "fetch_outputs"]);
    expect(calls[0]![1].workflow["4"].inputs.prompt).toBe("a red fox in snow");
    expect(calls[1]![1]).toMatchObject({ action: "wait", prompt_id: "pid-1" });
    expect(calls[3]![1]).toMatchObject({ prompt_id: "pid-1", out_dir: path.join(out, ".download", createHash("sha256").update("pid-1").digest("hex")) });
  });

  it("tool error surfaces as an exception", async () => {
    await expect(backend.generate({ prompt: "FAIL please" }, path.join(tmp(), "x"))).rejects.toThrow(/run_workflow/);
  });

  it.each([false, true])("MCP default submit preserves filename prefix, schema missing prefix=%s (F1)", async missingPrefix => {
    const dir = tmp();
    const state = path.join(dir, "state.json");
    const b = new McpImageBackend({ command: process.execPath, args: [path.join(FIXTURES, "fake-comfy-mcp.mjs")],
      env: { ...env, FAKE_COMFY_STATE: state, ...(missingPrefix ? { FAKE_COMFY_NO_PREFIX: "1" } : {}) },
      timeoutMs: 20_000, checkpoint: "fake.safetensors" });
    try {
      await b.submit({ prompt: "a fox" }, { filenamePrefix: "cs-abcdef123456-1" });
      const calls = JSON.parse(readFileSync(state, "utf8")).calls;
      expect(calls[0][0]).toBe("run_workflow");
      expect(calls[0][1].workflow["8"].inputs.filename_prefix).toBe("cs-abcdef123456-1");
    } finally { await b.close(); }
  });

  it("submit and collect split across processes: collect by the persisted prompt_id never resubmits; unknown job → UnknownJobError (R2)", async () => {
    const dir = tmp();
    const state = path.join(dir, "comfy-state.json");
    const mk = () => new McpImageBackend({ command: process.execPath, args: [path.join(FIXTURES, "fake-comfy-mcp.mjs")], env: { ...env, FAKE_COMFY_STATE: state }, timeoutMs: 20_000 });
    const a = mk();
    const id = await a.submit({ prompt: "crash between submit and collect" });
    await a.close(); // 进程在提交后退出
    const b = mk();
    try {
      const out = path.join(dir, "images", "tk");
      expect(await b.collect(id, out)).toEqual([path.join(out, "ComfyUI_00001_.png")]);
      const s = JSON.parse(readFileSync(state, "utf8")) as { submitted: string[]; calls: [string, any][] };
      expect(s.calls.filter((c) => c[0] === "run_workflow")).toHaveLength(1);
      expect(s.submitted).toEqual([id]);
      const err = await b.collect("pid-404", out).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(UnknownJobError);
    } finally {
      await b.close();
    }
  });
});

describe("HttpImageBackend submit / collect (fake ComfyUI HTTP)", () => {
  it("不会把带部分输出的非终态任务当成完成", async () => {
    let polls = 0;
    const fake = vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
      const url = new URL(String(input));
      if (url.pathname.startsWith("/history/")) return Response.json({ active: { status: { completed: ++polls >= 2 }, outputs: { "9": { images: [{ filename: "one.png" }] } } } });
      expect(polls).toBe(2);
      return new Response(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));
    });
    try { expect(await new HttpImageBackend({ baseUrl: "http://comfy.test", timeoutMs: 1000, pollMs: 1 }).collect("active", tmp())).toHaveLength(1); }
    finally { fake.mockRestore(); }
  });

  it("collect by prompt_id after a restart: no second POST /prompt; queued job is waited for; unknown job → UnknownJobError (R2)", async () => {
    const http = await import("node:http");
    const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
    let posts = 0;
    const known = new Map<string, number>(); // prompt_id → 剩余排队轮数
    const srv = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      const json = (o: unknown) => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(o));
      if (req.method === "POST" && url.pathname === "/prompt") {
        req.resume();
        req.on("end", () => {
          const id = `h${++posts}`;
          known.set(id, 2);
          json({ prompt_id: id });
        });
        return;
      }
      if (url.pathname.startsWith("/history/")) {
        const id = url.pathname.split("/").pop()!;
        const left = known.get(id);
        if (left === undefined || left > 0) return json({});
        return json({ [id]: { status: { completed: true }, outputs: { "9": { images: [{ filename: `${id}.png`, subfolder: "", type: "output" }] } } } });
      }
      if (url.pathname === "/queue") {
        const pending = [...known].filter(([, n]) => n > 0).map(([id]) => [0, id, {}, {}, []]);
        for (const [id, n] of known) if (n > 0) known.set(id, n - 1);
        return json({ queue_running: [], queue_pending: pending });
      }
      if (url.pathname === "/view") return res.writeHead(200, { "Content-Type": "image/png" }).end(PNG);
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const baseUrl = `http://127.0.0.1:${(srv.address() as any).port}`;
    try {
      const opts = { baseUrl, timeoutMs: 10_000, checkpoint: "x.safetensors", pollMs: 5 };
      const id = await new HttpImageBackend(opts).submit({ prompt: "a cat" });
      const out = path.join(tmp(), "images", "tk");
      const files = await new HttpImageBackend(opts).collect(id, out);
      expect(files).toEqual([path.join(out, `${id}.png`)]);
      expect(posts).toBe(1);
      await expect(new HttpImageBackend(opts).collect("nope", out)).rejects.toBeInstanceOf(UnknownJobError);
      expect(posts).toBe(1);
    } finally {
      srv.close();
    }
  });
});

describe("helpers", () => {
  it("parseToolResult handles FastMCP structured result and JSON text", () => {
    expect(parseToolResult({ structuredContent: { result: { prompt_id: "x" } } })).toEqual({ prompt_id: "x" });
    expect(parseToolResult({ content: [{ type: "text", text: '{"a":1}' }] })).toEqual({ a: 1 });
    expect(parseToolResult({ content: [{ type: "text", text: "plain" }] })).toEqual({ text: "plain" });
  });

  it("default HTTP workflow wires prompt and checkpoint", () => {
    const wf = defaultWorkflow("cat", "sd15.safetensors", 1) as any;
    expect(wf["6"].inputs.text).toBe("cat");
    expect(wf["4"].inputs.ckpt_name).toBe("sd15.safetensors");
    expect(wf["9"].class_type).toBe("SaveImage");
  });
});

describe("filename-prefix reconciliation over HTTP in both modes (F1/F2)", () => {
  const prefix = "cs-abcdef123456-1";
  const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
  const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
  const entry = (filename: string) => ({ status: { completed: true }, outputs: { "9": { images: [{ filename, type: "output", subfolder: "" }] } } });
  const make = (mode: "http" | "mcp") => mode === "http"
    ? new HttpImageBackend({ baseUrl: "http://comfy.test:8188", timeoutMs: 2000, checkpoint: "fake.safetensors", pollMs: 1 })
    : new McpImageBackend({ command: process.execPath, args: [path.join(FIXTURES, "fake-comfy-mcp.mjs")], env, timeoutMs: 2000 });

  it.each(["http", "mcp"] as const)("%s adopts prompt_id and outputs from full history, ignoring other attempt prefixes", async mode => {
    const seen: string[] = [];
    const steps: ReconcileStep[] = [];
    const filename = `${prefix}_00007_.png`;
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
      const url = new URL(String(input)); seen.push(url.pathname);
      if (url.pathname === "/history") return json({ other: entry(`${prefix}0_00001_.png`), adopted: entry(filename) });
      expect(url.pathname).toBe("/view");
      expect(url.searchParams.get("filename")).toBe(filename);
      expect(steps.at(-1)).toMatchObject({ step: "history", status: "matched", prompt_id: "adopted" });
      return new Response(PNG);
    });
    try {
      const out = path.join(tmp(), "images");
      expect(await make(mode).reconcile({ filenamePrefix: prefix }, out, undefined, async s => { steps.push(s); })).toEqual({ prompt_id: "adopted", images: [path.join(out, filename)] });
      expect(seen).toEqual(["/history", "/view"]);
      expect(readFileSync(path.join(out, filename))).toEqual(PNG);
    } finally { fetch.mockRestore(); }
  });

  it.each(["http", "mcp"] as const)("%s adopts a matching queued workflow and waits without submitting", async mode => {
    const steps: ReconcileStep[] = [];
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      expect(init?.method ?? "GET").toBe("GET");
      if (url.pathname === "/history") return json({});
      if (url.pathname === "/queue") return json({ queue_running: [[0, "queued", { "9": { class_type: "SaveImage", inputs: { filename_prefix: prefix } } }, {}, []]], queue_pending: [] });
      if (url.pathname === "/history/queued") return json({ queued: entry(`${prefix}_00001_.png`) });
      expect(url.pathname).toBe("/view");
      return new Response(PNG);
    });
    try {
      const out = tmp();
      const result = await make(mode).reconcile({ filenamePrefix: prefix }, out, undefined, async s => { steps.push(s); });
      expect(result.prompt_id).toBe("queued");
      expect(result.images).toHaveLength(1);
      expect(steps).toContainEqual({ step: "queue", status: "matched", prompt_id: "queued" });
      expect(steps.some(s => s.step === "probe")).toBe(false);
    } finally { fetch.mockRestore(); }
  });

  it.each(["http", "mcp"] as const)("%s probes all expected filenames after history pruning, even when the first is absent", async mode => {
    const names: string[] = [];
    const steps: ReconcileStep[] = [];
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
      const url = new URL(String(input));
      if (url.pathname === "/history") return json({});
      if (url.pathname === "/queue") return json({ queue_running: [], queue_pending: [] });
      expect(url.pathname).toBe("/view");
      expect(url.searchParams.get("type")).toBe("output");
      const filename = url.searchParams.get("filename")!; names.push(filename);
      return filename.endsWith("00002_.png") ? new Response(PNG) : new Response(null, { status: 404 });
    });
    try {
      const out = tmp();
      const result = await make(mode).reconcile({ filenamePrefix: prefix, count: 3 }, out, undefined, async s => { steps.push(s); });
      expect(result).toEqual({ images: [path.join(out, `${prefix}_00002_.png`)] });
      expect(names).toEqual([1, 2, 3].map(i => `${prefix}_0000${i}_.png`));
      expect(steps.at(-1)).toEqual({ step: "probe", status: "matched", filenames: [`${prefix}_00002_.png`] });
    } finally { fetch.mockRestore(); }
  });

  it("probes SaveImageAdvanced RGBA filenames after history pruning", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
      const url = new URL(String(input));
      if (url.pathname === "/history") return json({});
      if (url.pathname === "/queue") return json({ queue_running: [], queue_pending: [] });
      expect(url.searchParams.get("filename")).toBe(prefix + "_00001.png");
      return new Response(PNG);
    });
    try {
      expect((await make("http").reconcile({ filenamePrefix: prefix, imageOptions: { prompt: "cat", transparent: true } }, tmp())).images).toHaveLength(1);
    } finally { fetch.mockRestore(); }
  });

  it.each([404, 503])("probe HTTP %s distinguishes absence from service failure", async status => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
      const url = new URL(String(input));
      if (url.pathname === "/history") return json({});
      if (url.pathname === "/queue") return json({ queue_running: [], queue_pending: [] });
      return new Response(null, { status });
    });
    try {
      const run = make("http").reconcile({ filenamePrefix: prefix }, tmp());
      if (status === 404) await expect(run).resolves.toEqual({ images: [] });
      else await expect(run).rejects.toThrow("HTTP 503");
    } finally { fetch.mockRestore(); }
  });

  it("completion between history and queue reads is recovered before probing", async () => {
    let histories = 0;
    const filename = `${prefix}_00008_.png`;
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
      const url = new URL(String(input));
      if (url.pathname === "/history") return json(++histories === 1 ? {} : { late: entry(filename) });
      if (url.pathname === "/queue") return json({ queue_running: [], queue_pending: [] });
      expect(url.searchParams.get("filename")).toBe(filename);
      return new Response(PNG);
    });
    try { expect((await make("http").reconcile({ filenamePrefix: prefix }, tmp())).prompt_id).toBe("late"); }
    finally { fetch.mockRestore(); }
  });

  it.each([false, true])("HTTP submit patches SaveImage prefix with custom workflow=%s", async custom => {
    const dir = tmp();
    const workflowFile = path.join(dir, "workflow.json");
    writeFileSync(workflowFile, JSON.stringify(defaultWorkflow("old", "fake", 1)), "utf8");
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      expect(new URL(String(input)).pathname).toBe("/prompt");
      const workflow = JSON.parse(String(init?.body)).prompt;
      expect(workflow[custom ? "9" : "8"].inputs.filename_prefix).toBe(prefix);
      expect(custom ? workflow["6"].inputs.text : workflow["4"].inputs.prompt).toBe("new");
      return json({ prompt_id: "submitted" });
    });
    try {
      const b = new HttpImageBackend({ baseUrl: "http://comfy.test", timeoutMs: 2000, checkpoint: "fake", ...(custom ? { workflowFile } : {}) });
      await expect(b.submit({ prompt: "new" }, { filenamePrefix: prefix })).resolves.toBe("submitted");
    } finally { fetch.mockRestore(); }
  });
});

describe("workflow file route", () => {
  const wf = {
    "4": { class_type: "TextEncodeQwenImage21", inputs: { prompt: "old", negative_prompt: "" } },
    "6": { class_type: "KSampler", inputs: { seed: 1, steps: 8 } },
    "8": { class_type: "SaveImage", inputs: { filename_prefix: "x" } },
  };

  it("patchWorkflow writes prompt into the TextEncode node and randomizes seed", () => {
    const out = patchWorkflow(wf, "a cat", 42) as any;
    expect(out["4"].inputs.prompt).toBe("a cat");
    expect(out["6"].inputs.seed).toBe(42);
    expect((wf as any)["4"].inputs.prompt).toBe("old");
    const t = patchWorkflow({ "9": { class_type: "CLIPTextEncode", inputs: { text: "" } } }, "dog", 1) as any;
    expect(t["9"].inputs.text).toBe("dog");
    expect(() => patchWorkflow({ "1": { class_type: "KSampler", inputs: {} } }, "x", 1)).toThrow(/提示词节点/);
  });

  it("MCP backend with workflowFile uses run_workflow(wait=false) with the patched copy", async () => {
    const dir = tmp();
    const file = path.join(dir, "wf.json");
    writeFileSync(file, JSON.stringify(wf));
    const b = new McpImageBackend({
      command: process.execPath,
      args: [path.join(FIXTURES, "fake-comfy-mcp.mjs")],
      env,
      timeoutMs: 20_000,
      workflowFile: file,
      promptNode: "4",
    });
    try {
      const out = path.join(dir, "images", "t2");
      const id = await b.submit({ prompt: "a blue bird" }, { filenamePrefix: "cs-abcdef123456-2" });
      const files = await b.collect(id, out);
      expect(files).toHaveLength(1);
      const calls = JSON.parse(readFileSync(path.join(out, ".download", createHash("sha256").update("pid-1").digest("hex"), "calls.json"), "utf8")) as [string, any][];
      expect(calls.map((c) => c[0])).toEqual(["run_workflow", "job", "job", "fetch_outputs"]);
      expect(calls[0]![1].wait).toBe(false);
      expect(calls[0]![1].workflow["4"].inputs.prompt).toBe("a blue bird");
      expect(calls[0]![1].workflow["8"].inputs.filename_prefix).toBe("cs-abcdef123456-2");
      expect(JSON.parse(readFileSync(file, "utf8"))["8"].inputs.filename_prefix).toBe("x");
    } finally {
      await b.close();
    }
  });

  it("loopback proxy relays TCP to the target", async () => {
    const http = await import("node:http");
    const srv = http.createServer((_req, res) => res.end("pong"));
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const port = (srv.address() as any).port;
    const proxy = await startLoopbackProxy(`http://127.0.0.1:${port}`, 0);
    try {
      expect(await (await fetch(`${proxy.url}/x`)).text()).toBe("pong");
      expect(isLoopbackUrl(proxy.url)).toBe(true);
      expect(isLoopbackUrl("http://host.docker.internal:8188")).toBe(false);
    } finally {
      await proxy.close();
      srv.close();
    }
  });
});
