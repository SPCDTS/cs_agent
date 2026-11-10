import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import * as models from "../src/models";
import { SandboxDO } from "../src/sandbox/do";
import { RegistryDO } from "../src/registry";
import { MCP_CONFIG } from "../src/mcp/config";
import { MediaRepository, readMediaToken } from "../src/media/repository";
import { WorkspaceManager } from "../src/sandbox/workspace";
import type { SandboxClient } from "../src/sandbox/client";
import { sha256 } from "../src/media/model";
import { scriptedModel } from "./events-helpers";
import { action, connect, input, reply } from "./helpers";

const sockets: WebSocket[] = [];
afterEach(async () => { for (const socket of sockets.splice(0)) socket.close(); vi.restoreAllMocks(); await reset(); });
const data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aH1sAAAAASUVORK5CYII=";
const png = Uint8Array.from(atob(data), c => c.charCodeAt(0));
const group = "group:200000001";
const source = 'import { mkdir, writeFile } from "node:fs/promises"; const r = await fetch("https://shop.example.com/jersey.png"); if (!r.ok) throw Error(String(r.status)); await mkdir("out", {recursive:true}); await writeFile("out/jersey.png", new Uint8Array(await r.arrayBuffer()));';
const script = `text(await tools.write({path:"download.mjs",content:${JSON.stringify(source)}})); text(await tools.bash({command:"node download.mjs"})); const result=await tools.read({path:"out/jersey.png"}); image(result.image);`;

// 仅替代容器边界；Thread、Code Mode、持久化、资产导出和 QQ 发送均走真实实现。
// 实际脚本联网下载另由 sandbox-server.node.mjs 验证。
async function installRuntime(scope: string) {
  await runInDurableObject(env.SANDBOX.getByName(scope), (instance, state) => {
    let files = new Map<string, Uint8Array>(), ready = false;
    const relative = (path: string) => path.replace(/^\/work\//, "");
    const client: SandboxClient = {
      async restore(snapshot, read) { files = new Map(await Promise.all(snapshot.files.map(async f => [f.path, await read(f)] as const))); ready = true; },
      async writeFile(path, text) { const bytes = new TextEncoder().encode(text); files.set(relative(path), bytes); return { bytes: bytes.length }; },
      async exec(command) {
        expect(command).toBe("node download.mjs");
        expect(new TextDecoder().decode(files.get("download.mjs"))).toBe(source);
        files.set("out/jersey.png", png);
        return { stdout: "downloaded", stderr: "", code: 0, timedOut: false, truncated: false };
      },
      async readFile(path) { if (!files.has(relative(path))) throw Error("not_found"); return { kind: "image", data, mimeType: "image/png" }; },
      async readBlob(path) { const bytes = files.get(relative(path)); if (!bytes) throw Error("not_found"); return bytes; },
      async snapshot() {
        const entries = await Promise.all([...files].map(async ([path, bytes]) => ({ path, bytes: bytes.length, sha256: await sha256(bytes), mime: path.endsWith(".png") ? "image/png" : "text/javascript", mode: 420 })));
        return { files: entries, directories: ["out"], totalBytes: entries.reduce((n, f) => n + f.bytes, 0) };
      },
      async list() { return []; },
      async editFile() { throw Error("unused"); },
    };
    Object.defineProperty(instance, "workspace", { value: new WorkspaceManager({
      workspace: "workspace:" + state.id.toString(), storage: state.storage, bucket: env.ASSETS, runtime: client,
      runtimeReady: () => ready, resetRuntime: async () => { ready = false; files.clear(); },
    }) });
  });
}
function inspectThenSend() {
  const faux = fauxProvider({ models: [{ id: "test", input: ["text", "image"] }], tokensPerSecond: Infinity });
  const images: string[] = [];
  let step = 0;
  const respond: FauxResponseFactory = transcript => {
    faux.setResponses([respond]);
    for (const message of transcript.messages) if (message.role === "toolResult") for (const block of message.content) if (block.type === "image") images.push(block.data);
    if (step++ === 0) return fauxAssistantMessage(fauxToolCall("codemode", { code: script }), { stopReason: "toolUse" });
    if (step === 2) return fauxAssistantMessage(fauxToolCall("send_file", { path: "/work/out/jersey.png", name: "队服.png" }), { stopReason: "toolUse" });
    return fauxAssistantMessage("done");
  };
  faux.setResponses([respond]);
  vi.spyOn(models, "openModels").mockImplementation(() => { const registry = createModels(); registry.setProvider(faux.provider); return registry; });
  return { images };
}

describe("群聊通用脚本与产物发送", () => {
  it("无 MCP 授权的群成员可写脚本、执行、查看并在原群发送已提交图片", async () => {
    vi.spyOn(RegistryDO.prototype, "mcpConfig").mockReturnValue({ ...MCP_CONFIG, enabled: false, servers: [] });
    await installRuntime(group);
    const seen = inspectThenSend(), { socket, frames } = await connect(sockets);
    const run = env.THREAD.getByName(group).submit(input(1, "下载队服照片发一下", 10000004, 200000001, true));
    const sent = await action(frames);
    expect(sent.params).toMatchObject({ group_id: "200000001", message: [
      { type: "at", data: { qq: "10000004" } },
      { type: "image", data: { file: expect.stringContaining("/media/object?token=") } },
    ] });
    const image = sent.params.message?.find(segment => segment.type === "image");
    if (!Check(Type.Object({ data: Type.Object({ file: Type.String() }) }), image)) throw Error("missing_image");
    const token = new URL(image.data.file).searchParams.get("token");
    if (!token) throw Error("missing_token");
    const asset = await readMediaToken(env.ASSETS, token);
    expect(asset.bytes).toEqual(png);
    expect(asset.ref).toMatchObject({ scope: group, name: "队服.png", kind: "image" });
    reply(socket, sent.echo);
    expect(await run).toEqual({ status: "done" });
    expect(seen.images).toContain(data);
    expect((await env.SANDBOX.getByName(group).readBlob("out/jersey.png")).bytes).toEqual(png);
    for (const scope of ["owner", "group:200000002"]) {
      await runInDurableObject(env.SANDBOX.getByName(scope), async instance => { if (!(instance instanceof SandboxDO)) throw Error("expected SandboxDO"); await expect(instance.readBlob("out/jersey.png")).rejects.toThrow("not_found"); });
      await expect(new MediaRepository({ bucket: env.ASSETS, scope }).get(asset.ref.id)).rejects.toThrow("asset_not_found");
    }
  });

  it("群网页回合使用所属工作区，send_file 只写网页输出", async () => {
    await installRuntime(group);
    const seen = inspectThenSend(), thread = env.THREAD.getByName(group);
    await thread.submitWeb(group, crypto.randomUUID(), "下载图片");
    await expect.poll(async () => (await thread.chatView(group)).messages.some(m => m.role === "assistant")).toBe(true);
    await expect.poll(async () => (await thread.chatView(group)).active).toBe(0);
    expect((await thread.chatView(group)).messages.find(m => m.role === "assistant")).toMatchObject({
      source: "web", assets: [{ scope: group, name: "队服.png", kind: "image" }],
    });
    expect(seen.images).toContain(data);
    expect(await env.BRIDGE.getByName("napcat").deliveryList()).toHaveLength(0);
  });

  it("群执行中会话代次撤销后，后续嵌套调用和发送均拒绝", async () => {
    const exec = vi.spyOn(SandboxDO.prototype, "exec").mockImplementation(async () => {
      await runInDurableObject(env.THREAD.getByName(group), (_instance, state) => { state.storage.sql.exec("UPDATE session_state SET generation=generation+1 WHERE id=1"); });
      return { stdout: "first", stderr: "", code: 0, timedOut: false, truncated: false };
    });
    const exported = vi.spyOn(SandboxDO.prototype, "exportAsset");
    const seen = scriptedModel([
      { name: "codemode", args: { code: 'text(await tools.bash({command:"first"})); text(await tools.bash({command:"second"}));' } },
      { name: "send_file", args: { path: "out/jersey.png" } },
    ]);
    await env.THREAD.getByName(group).submit(input(1, "运行", 10000004, 200000001, true));
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exported).not.toHaveBeenCalled();
    expect(seen.outputs.join("\n")).toContain("本回合无权使用沙箱工具");
    expect(await env.BRIDGE.getByName("napcat").deliveryList()).toHaveLength(0);
  });

  it("开放群工作区仍限制 Cloudflare 资源管理与技能发布", async () => {
    const publish = vi.spyOn(RegistryDO.prototype, "skillPublish");
    const seen = scriptedModel([{ name: "codemode", args: { code: 'text(ALL_TOOLS.map(tool => tool.name)); try { text(await tools.skill_inspect({path:"out/skill"})); } catch(error) { text(String(error)); } try { text(await tools.skill_publish({path:"out/skill",workspaceRevision:"0",expectedRevision:"absent"})); } catch(error) { text(String(error)); }' } }]);
    await env.THREAD.getByName(group).submit(input(1, "检查工具", 10000004, 200000001, true));
    expect(seen.outputs.join("\n")).toContain("skill_publish_denied");
    expect(seen.outputs.join("\n")).not.toMatch(/sandbox_list|sandbox_create|web_import_image|web_fetch/);
    expect(publish).not.toHaveBeenCalled();
  });

  it.each(["private", "self", "schedule"] as const)("拒绝 %s 回合的脚本执行", async kind => {
    const exec = vi.spyOn(SandboxDO.prototype, "exec");
    scriptedModel([{ name: "codemode", args: { code: 'text(await tools.bash({command:"forbidden"}));' } }]);
    const incoming = input(1, "运行", kind === "self" ? 10000000 : 10000004, kind === "private" ? undefined : 200000001, true);
    await env.THREAD.getByName(kind === "private" ? "private:10000004" : group).submit({ ...incoming, ...(kind === "schedule" ? { kind: "schedule" as const } : {}) });
    expect(exec).not.toHaveBeenCalled();
  });
});
