import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { HttpImageBackend, McpImageBackend, UnknownJobError, defaultWorkflow, parseToolResult, patchWorkflow } from "../../src/agent/image-gen.js";
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
    const files = await backend.generate("a red fox in snow", out);
    expect(files).toEqual([path.join(out, "ComfyUI_00001_.png")]);
    expect(existsSync(files[0]!)).toBe(true);
    const calls = JSON.parse(readFileSync(path.join(out, "calls.json"), "utf8")) as [string, any][];
    expect(calls.map((c) => c[0])).toEqual(["generate_image", "job", "job", "fetch_outputs"]);
    expect(calls[0]![1]).toMatchObject({ prompt: "a red fox in snow", wait: false });
    expect(calls[1]![1]).toMatchObject({ action: "wait", prompt_id: "pid-1" });
    expect(calls[3]![1]).toMatchObject({ prompt_id: "pid-1", out_dir: out });
  });

  it("tool error surfaces as an exception", async () => {
    await expect(backend.generate("FAIL please", path.join(tmp(), "x"))).rejects.toThrow(/generate_image/);
  });

  it("submit and collect split across processes: collect by the persisted prompt_id never resubmits; unknown job → UnknownJobError (R2)", async () => {
    const dir = tmp();
    const state = path.join(dir, "comfy-state.json");
    const mk = () => new McpImageBackend({ command: process.execPath, args: [path.join(FIXTURES, "fake-comfy-mcp.mjs")], env: { ...env, FAKE_COMFY_STATE: state }, timeoutMs: 20_000 });
    const a = mk();
    const id = await a.submit("crash between submit and collect");
    await a.close(); // 进程在提交后退出
    const b = mk();
    try {
      const out = path.join(dir, "images", "tk");
      expect(await b.collect(id, out)).toEqual([path.join(out, "ComfyUI_00001_.png")]);
      const s = JSON.parse(readFileSync(state, "utf8")) as { submitted: string[]; calls: [string, any][] };
      expect(s.calls.filter((c) => c[0] === "generate_image")).toHaveLength(1);
      expect(s.submitted).toEqual([id]);
      const err = await b.collect("pid-404", out).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(UnknownJobError);
    } finally {
      await b.close();
    }
  });
});

describe("HttpImageBackend submit / collect (fake ComfyUI HTTP)", () => {
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
      const id = await new HttpImageBackend(opts).submit("a cat");
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
      const files = await b.generate("a blue bird", out);
      expect(files).toHaveLength(1);
      const calls = JSON.parse(readFileSync(path.join(out, "calls.json"), "utf8")) as [string, any][];
      expect(calls.map((c) => c[0])).toEqual(["run_workflow", "job", "job", "fetch_outputs"]);
      expect(calls[0]![1].wait).toBe(false);
      expect(calls[0]![1].workflow["4"].inputs.prompt).toBe("a blue bird");
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
