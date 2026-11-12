import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { SandboxDO } from "../src/sandbox/do";
import { CLOUDFLARE_INSTRUCTIONS, CLOUDFLARE_RESOURCE_INSTRUCTIONS } from "../src/sandbox/registration";
import { workPath } from "../src/sandbox/client";
import { RegistryDO } from "../src/registry";
import { BridgeDO } from "../src/bridge";
import { threadWithBindings } from "./thread-fixture";
import { MCP_CONFIG } from "../src/mcp/config";
import { scriptedModel } from "./events-helpers";
import { input } from "./helpers";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import * as models from "../src/models";

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

const CODING_TOOLS = ["read", "write", "edit", "bash"];
const auditRows = (kind: string) => runInDurableObject(env.THREAD.getByName("owner"), (_instance, state) =>
  state.storage.sql.exec<{ detail: string }>("SELECT detail FROM events WHERE kind = ?", kind).toArray().map(row => JSON.parse(row.detail) as Record<string, unknown>));
const admin = (method: string, path: string) =>
  worker.fetch(new Request(`https://test${path}`, { method, headers: { Authorization: "Bearer test-admin-only" } }), { ...env, ADMIN_TOKEN: "test-admin-only" });

describe("workPath", () => {
  it("resolves model paths under /work and rejects anything that leaves it", () => {
    expect(workPath("a/b.txt")).toBe("/work/a/b.txt");
    expect(workPath("./out/../x.py")).toBe("/work/x.py");
    expect(workPath("/work")).toBe("/work");
    expect(workPath("/work//out/")).toBe("/work/out");
    for (const raw of ["../etc/passwd", "/etc/passwd", "/work/../etc", "/workspace/x", "a/../../..", "/"]) expect(() => workPath(raw), raw).toThrow("path_denied");
    expect(() => workPath("a\0b")).toThrow("invalid_request");
  });
});

describe("coding tools", () => {
  it("超长文本通过同一文件环境保存全文，输出返回可继续读取的路径", async () => {
    vi.spyOn(SandboxDO.prototype, "createTempDir").mockResolvedValue("/work/.codemode/full-text");
    const write = vi.spyOn(SandboxDO.prototype, "writeFile").mockResolvedValue({ bytes: 50000 });
    const seen = scriptedModel([{ name: "codemode", args: { code: 'text("完整文本".repeat(12500));' } }]);
    await env.THREAD.getByName("owner").submit(input(1, "生成完整输出", 10000001));
    expect(write).toHaveBeenCalledWith("/work/.codemode/full-text/output.txt", "完整文本".repeat(12500));
    expect(seen.outputs.join("\n")).toContain("Full output: /work/.codemode/full-text/output.txt");
  });
  it.each(["persistence", "owner", "generation"] as const)("自动保存遇到 %s 失败时报告原因，不宣称已保存", async failure => {
    const data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aH1sAAAAASUVORK5CYII=";
    const seen = scriptedModel([{ name: "codemode", args: { code: `image({type:"image",data:${JSON.stringify(data)},mimeType:"image/png"});` } }]);
    const write = vi.spyOn(SandboxDO.prototype, "writeFile").mockRejectedValue(Error("persistence_failed"));
    await runInDurableObject(env.THREAD.getByName("owner"), async (instance, state) => {
      const currentEnv = { ...env, QQ_OWNER: "10000001", MEMORY_EXTRACT_NAMESPACES: "" };
      vi.spyOn(SandboxDO.prototype, "createTempDir").mockImplementation(async () => {
        if (failure === "owner") currentEnv.QQ_OWNER = "10000002";
        if (failure === "generation") await runInDurableObject(env.THREAD.getByName("owner"), (_current, currentState) => { currentState.storage.sql.exec("UPDATE session_state SET generation=generation+1 WHERE id=1"); });
        return "/work/.codemode/test";
      });
      await threadWithBindings(instance, state, currentEnv).submit(input(1, "截图", 10000001));
    });
    expect(write).toHaveBeenCalledTimes(failure === "persistence" ? 1 : 0);
    expect(seen.outputs.join("\n")).toContain(failure === "persistence" ? "persistence_failed" : "permission_denied");
    expect(seen.outputs.join("\n")).not.toContain("Image saved to");
  });
  it.each(["foreign", "group"] as const)("send_file 的资源 ID 不允许 %s 越权", async kind => {
    const resource = await env.CLOUDFLARE_WORKSPACE_RESOURCES.getByName("owner").create(kind === "foreign" ? "other" : "owner", "send-target", {});
    const exported = vi.spyOn(SandboxDO.prototype, "exportAsset");
    const seen = scriptedModel([{ name: "send_file", args: { path: "/work/out/image.png", sandboxId: resource.id } }]);
    const group = kind === "group";
    await env.THREAD.getByName(group ? "group:200000001" : "owner").submit(input(1, "发送图片", group ? 10000004 : 10000001, group ? 200000001 : undefined, group));
    expect(exported).not.toHaveBeenCalled();
    expect(seen.outputs.join("\n")).toContain(group ? "permission_denied" : "invalid_request");
  });
  it("offers sandbox instructions and only Code Mode in owner and group turns", async () => {
    const seen = scriptedModel([{ name: "", args: {} }, { name: "", args: {} }]);
    expect(await env.THREAD.getByName("owner").submit(input(1, "写个脚本", 10000001))).toEqual({ status: "done" });
    expect(seen.requests[0]!.tools).toContain("codemode");
    expect(Object.values(seen.requests[0]!.sections)).toContain(CLOUDFLARE_INSTRUCTIONS + CLOUDFLARE_RESOURCE_INSTRUCTIONS);
    for (const name of [...CODING_TOOLS, "skill_inspect", "skill_publish"]) expect(seen.requests[0]!.tools).not.toContain(name);
    expect(await env.THREAD.getByName("group:200000001").submit(input(2, "跑个脚本", 10000003, 200000001, true))).toEqual({ status: "done" });
    expect(Object.values(seen.requests[1]!.sections)).toContain(CLOUDFLARE_INSTRUCTIONS);
    for (const name of CODING_TOOLS) expect(seen.requests[1]!.tools).not.toContain(name);
  });

  it("runs nested sandbox calls with MCP disabled and gives each call its own task ID", async () => {
    vi.spyOn(RegistryDO.prototype, "mcpConfig").mockReturnValue({ ...MCP_CONFIG, enabled: false, servers: [] });
    const exec = vi.spyOn(SandboxDO.prototype, "exec").mockResolvedValue({ stdout: "ok", stderr: "", code: 0, timedOut: false, truncated: false });
    const seen = scriptedModel([{ name: "codemode", args: { code: 'text(await tools.bash({command:"one"})); text(await tools.bash({command:"two"}));' } }]);
    expect(await env.THREAD.getByName("owner").submit(input(1, "运行", 10000001))).toEqual({ status: "done" });
    expect(exec).toHaveBeenCalledTimes(2);
    expect(exec.mock.calls[0]![1]!.operationId).not.toBe(exec.mock.calls[1]![1]!.operationId);
    expect(seen.outputs.join("\n")).toContain("ok");
    const store = env.REQUESTS.getByName("main"), page = await store.list({ since: 0, until: Date.now() + 1000, limit: 10 });
    const request = page.requests.find(row => row.actor === "thread" && row.toolCalls?.some(call => call.name === "codemode"));
    expect(request).toBeDefined();
    const detail = await store.detail(request!.id), root = detail!.tools.find(tool => tool.name === "codemode")!;
    expect(detail!.tools.filter(tool => tool.parentCallId === root.callId).map(tool => tool.argumentPreview).sort()).toEqual(["command: one", "command: two"]);
    expect((await store.toolExecution(root.id))?.sourceRequestId).toBe(request!.id);
    const followup = page.requests.find(row => row.actor === "thread" && !row.toolCalls?.length && row.purpose === "conversation");
    expect((await store.contextInspection(followup!.id))?.analysis?.items.find(item => item.execution)?.execution).toMatchObject({ calls: 2, label: "bash ×2" });
  });

  it("retired device endpoints are unavailable", async () => {
    expect((await admin("GET", "/admin/sandbox-devices/overview")).status).toBe(404);
    expect((await admin("POST", "/sandbox-devices/claim")).status).toBe(404);
  });

  it("passes sandbox images through structured read and image() into the model transcript", async () => {
    const data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aH1sAAAAASUVORK5CYII=";
    vi.spyOn(SandboxDO.prototype, "readFile").mockResolvedValue({ kind: "image", data, mimeType: "image/png" });
    const faux = fauxProvider({ models: [{ id: "test", input: ["text", "image"] }], tokensPerSecond: Infinity });
    const images: string[] = [];
    let called = false;
    const respond: FauxResponseFactory = transcript => {
      faux.setResponses([respond]);
      for (const message of transcript.messages) if (message.role === "toolResult") {
        for (const block of message.content) if (block.type === "image") images.push(block.data);
      }
      if (called) return fauxAssistantMessage("done");
      called = true;
      return fauxAssistantMessage(fauxToolCall("codemode", { code: 'const result = await tools.read({path:"out/p.png"}); image(result.image);' }), { stopReason: "toolUse" });
    };
    faux.setResponses([respond]);
    vi.spyOn(models, "openModels").mockImplementation(() => { const registry = createModels(); registry.setProvider(faux.provider); return registry; });
    await env.THREAD.getByName("owner").submit(input(1, "查看图片", 10000001));
    expect(images).toContain(data);
  });

  it("refuses direct model sandbox calls", async () => {
    const exec = vi.spyOn(SandboxDO.prototype, "exec");
    scriptedModel([{ name: "bash", args: { command: "must-not-run" } }]);
    await env.THREAD.getByName("owner").submit(input(1, "运行", 10000001));
    expect(exec).not.toHaveBeenCalled();
  });

  it.each(["owner", "generation"] as const)("rechecks %s before every nested sandbox call", async change => {
    const seen = scriptedModel([{ name: "codemode", args: { code: 'text(await tools.bash({command:"first"})); text(await tools.bash({command:"second"}));' } }]);
    await runInDurableObject(env.THREAD.getByName("owner"), async (_instance, state) => {
      const currentEnv = { ...env, QQ_OWNER: "10000001", MEMORY_EXTRACT_NAMESPACES: "" };
      const exec = vi.spyOn(SandboxDO.prototype, "exec").mockImplementation(async () => {
        if (change === "owner") currentEnv.QQ_OWNER = "10000002";
        else await runInDurableObject(env.THREAD.getByName("owner"), (_current, currentState) => { currentState.storage.sql.exec("UPDATE session_state SET generation = generation + 1 WHERE id=1"); });
        return { stdout: "first", stderr: "", code: 0, timedOut: false, truncated: false };
      });
      await threadWithBindings(_instance, state, currentEnv).submit(input(1, "运行", 10000001));
      expect(exec).toHaveBeenCalledTimes(1);
    });
    expect(seen.outputs.join("\n")).toContain("本回合无权使用沙箱工具");
  });

  it("refuses sandbox calls in event turns even when Code Mode is available", async () => {
    const exec = vi.spyOn(SandboxDO.prototype, "exec");
    const seen = scriptedModel([{ name: "codemode", args: { code: 'text(await tools.bash({command:"forbidden"}));' } }]);
    await env.THREAD.getByName("owner").submit({ ...input(1, "事件", 10000001), kind: "event" });
    expect(exec).not.toHaveBeenCalled();
    expect(seen.outputs.join("\n")).toContain("本回合无权使用沙箱工具");
  });

  it("tells the model the sandbox is unavailable and audits only the classification", async () => {
    const seen = scriptedModel([{ name: "codemode", args: { code: 'text(await tools.bash({command:"cat 秘密文件.txt"}));' } }, { name: "codemode", args: { code: 'text(await tools.write({path:"out/a.txt",content:"机密内容"}));' } }, { name: "", args: {} }]);
    expect(await env.THREAD.getByName("owner").submit(input(1, "跑一下", 10000001))).toEqual({ status: "done" });
    expect(seen.outputs[0]).toContain("sandbox_unavailable");
    expect(seen.outputs[1]).toContain("sandbox_unavailable");
    const exec = await auditRows("coding_exec"), write = await auditRows("coding_write");
    expect(exec).toEqual([{ result: "sandbox_unavailable", commandLength: "cat 秘密文件.txt".length, ms: expect.any(Number) }]);
    expect(write).toEqual([{ result: "sandbox_unavailable", ms: expect.any(Number) }]);
    expect(JSON.stringify([exec, write])).not.toMatch(/秘密|机密|out\/a/);
  });

  it("shows stdout, stderr and a non-zero exit code to the model", async () => {
    const exec = vi.spyOn(SandboxDO.prototype, "exec").mockResolvedValue({ stdout: "built\n", stderr: "warning: x\n", code: 2, timedOut: false, truncated: false });
    const seen = scriptedModel([{ name: "codemode", args: { code: 'text(await tools.bash({command:"make",timeout:90}));' } }, { name: "", args: {} }]);
    expect(await env.THREAD.getByName("owner").submit(input(1, "编译", 10000001))).toEqual({ status: "done" });
    expect(exec).toHaveBeenCalledWith("make", { cwd: "/work", timeoutMs: 90_000, operationId: expect.stringMatching(/^task:/) });
    expect(seen.outputs[0]).toContain("built\n\n[stderr]\nwarning: x\n\nCommand exited with code 2");
    expect(await auditRows("coding_exec")).toEqual([{ result: "ok", commandLength: 4, code: 2, ms: expect.any(Number) }]);
  });

  it("points read at the next offset and repairs edits sent as a JSON string", async () => {
    vi.spyOn(SandboxDO.prototype, "readFile").mockResolvedValue({ text: "a\nb", startLine: 1, endLine: 2, totalLines: 5 });
    const edit = vi.spyOn(SandboxDO.prototype, "editFile").mockResolvedValue({ replaced: 1 });
    const seen = scriptedModel([
      { name: "codemode", args: { code: 'text((await tools.read({path:"main.py",limit:2})).text);' } },
      { name: "codemode", args: { code: 'text(await tools.edit({path:"main.py",edits:JSON.stringify([{oldText:"a",newText:"A"}])}));' } },
      { name: "", args: {} },
    ]);
    expect(await env.THREAD.getByName("owner").submit(input(1, "改一下", 10000001))).toEqual({ status: "done" });
    expect(seen.outputs[0]).toContain("a\nb\n\n[Showing lines 1-2 of 5. Use offset=3 to continue.]");
    expect(edit).toHaveBeenCalledWith("main.py", [{ oldText: "a", newText: "A" }], expect.stringMatching(/^task:/));
    expect(seen.outputs[1]).toContain("Successfully replaced 1 block(s) in main.py.");
  });
});

describe("admin sandbox", () => {
  it("shows owner and group sandbox states and maps a reset without containers to 503", async () => {
    vi.spyOn(BridgeDO.prototype, "threadList").mockResolvedValue([{ key: "group:200000001", seenAt: 1 }, { key: "private:10000003", seenAt: 1 }]);
    const overview = await (await admin("GET", "/admin/overview")).json<{ threads: { key: string; sandbox?: string }[] }>();
    expect(overview.threads.find(thread => thread.key === "owner")?.sandbox).toBe("unavailable");
    expect(overview.threads.find(thread => thread.key === "group:200000001")?.sandbox).toBe("unavailable");
    expect(overview.threads.find(thread => thread.key === "private:10000003")?.sandbox).toBeUndefined();
    const response = await admin("POST", "/admin/threads/owner/sandbox/reset");
    expect([response.status, await response.json()]).toEqual([503, { error: "sandbox_unavailable" }]);
    expect((await admin("POST", "/admin/threads/nobody/sandbox/reset")).status).toBe(404);
  });
});

it("Code Mode 创建资源并把显式 sandboxId 路由至该 Cloudflare DO", async () => {
  const targets: string[] = [];
  vi.spyOn(SandboxDO.prototype, "exec").mockImplementation(async function(this: SandboxDO) {
    targets.push((await this.files()).workspace);
    return { stdout: "ok", stderr: "", code: 0, timedOut: false, truncated: false };
  });
  const seen = scriptedModel([{ name: "codemode", args: { code: 'const list=await tools.sandbox_list({}); const created=await tools.sandbox_create({providerId:"cloudflare",sourceId:list.assignedSandboxId}); text(created); text(await tools.bash({sandboxId:created.id,command:"pwd"})); text(await tools.bash({command:"pwd"}));' } }]);
  await env.THREAD.getByName("owner").submit(input(1, "创建独立沙箱", 10000001));
  expect(seen.outputs.join("\n")).toContain('"kind":"cloudflare"');
  expect(targets).toHaveLength(2);
  expect(targets[0]).not.toBe(targets[1]);
  expect(targets[1]).toBe("workspace:" + env.SANDBOX.idFromName("owner"));
});
