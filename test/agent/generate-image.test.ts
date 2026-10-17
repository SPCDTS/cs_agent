import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { McpImageBackend, defaultWorkflow, parseToolResult, patchWorkflow } from "../../src/agent/tools/generate-image.js";
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
