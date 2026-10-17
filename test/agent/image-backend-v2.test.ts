import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpImageBackend, McpImageBackend } from "../../src/agent/image-gen.js";
import { QWEN_MODELS } from "../../src/agent/qwen-workflow.js";
import { FIXTURES, tmp } from "./helpers.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const json = (data: unknown) => new Response(JSON.stringify(data));
afterEach(() => vi.restoreAllMocks());
const env = () => Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string,string] => entry[1] !== undefined));

describe("ImageBackend v2", () => {
  it("HTTP 上传按票据分目录，参数进入生成图，保留 seed/负面提示词与 count", async () => {
    const dir = tmp(); const ref = path.join(dir, "ref.png"); await fs.writeFile(ref, PNG);
    const calls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input)); calls.push(url.pathname);
      if (url.pathname === "/upload/image") {
        const form = init!.body as FormData;
        expect(form.get("subfolder")).toBe("ticket");
        expect(form.get("type")).toBe("input");
        expect(Buffer.from(await (form.get("image") as Blob).arrayBuffer())).toEqual(PNG);
        return json({ name: "ref.png", subfolder: "ticket", type: "input" });
      }
      expect(url.pathname).toBe("/prompt");
      const graph = JSON.parse(String(init!.body)).prompt;
      expect(graph["20"].inputs.image).toBe("ticket/ref.png");
      expect(graph["4"].inputs).toMatchObject({ prompt: "保留猫，杯子改红色", negative_prompt: "模糊", vae: ["3",0], "images.image_1": ["20",0] });
      expect(graph["6"].inputs).toMatchObject({ seed: 0, steps: 8, cfg: 1, latent_image: ["5",0] });
      expect(graph["5"].inputs).toEqual({ samples: ["4",2], amount: 3 });
      return json({ prompt_id: "one" });
    });
    const backend = new HttpImageBackend({ baseUrl: "http://fake.test", timeoutMs: 300000 });
    await expect(backend.submit({ prompt: "保留猫，杯子改红色", reference_images: [ref], negative_prompt: "模糊", count: 3, seed: 0 }, { filenamePrefix: "out", referenceSubfolder: "ticket" })).resolves.toBe("one");
    expect(calls).toEqual(["/upload/image", "/prompt"]);
  });
  it.each([false, true])("MCP 上传：具备子目录能力=%s；否则同 URL HTTP 回退", async supported => {
    const dir = tmp(); const ref = path.join(dir, "ref.png"); await fs.writeFile(ref, PNG);
    const state = path.join(dir, "state.json");
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      expect(String(input)).toBe("http://fake.test/upload/image");
      expect((init!.body as FormData).get("subfolder")).toBe("ticket");
      return json({ name: "ref.png", subfolder: "ticket" });
    });
    const backend = new McpImageBackend({ command: process.execPath, args: [path.join(FIXTURES, "fake-comfy-mcp.mjs")],
      env: { ...env(), COMFYUI_URL: "http://fake.test", FAKE_COMFY_STATE: state, FAKE_COMFY_UPLOAD: supported ? "subfolder" : "paths" }, timeoutMs: 10000 });
    try {
      await backend.submit({ prompt: "改色", reference_images: [ref] }, { filenamePrefix: "out", referenceSubfolder: "ticket" });
      const calls = JSON.parse(await fs.readFile(state, "utf8")).calls;
      expect(calls.map((c: any) => c[0])).toEqual(supported ? ["upload_file", "run_workflow"] : ["run_workflow"]);
      expect(calls.at(-1)[1].workflow["20"].inputs.image).toBe("ticket/ref.png");
      expect(fetch).toHaveBeenCalledTimes(supported ? 0 : 1);
      await expect(fs.access(calls.at(-1)[1].workflow_path)).rejects.toThrow(); // 临时工作流已清理
    } finally { await backend.close(); }
  });
  it("透明自检和调用都明确报告缺少的 VAE，不提交采样", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
      if (String(input).endsWith("system_stats")) return json({});
      return json({ VAELoader: { input: { required: { vae_name: [[]] } } } });
    });
    const backend = new HttpImageBackend({ baseUrl: "http://fake.test", timeoutMs: 10000 });
    expect(await backend.selfCheck()).toMatchObject({ transparent: "透明输出未启用：缺少 " + QWEN_MODELS.vae });
    await expect(backend.submit({ prompt: "猫", transparent: true })).rejects.toThrow("透明输出未启用：缺少 " + QWEN_MODELS.vae);
    expect(fetch.mock.calls.some(([u]) => String(u).endsWith("/prompt"))).toBe(false);
  });
});
