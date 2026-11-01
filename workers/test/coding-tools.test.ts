import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { SandboxDO } from "../src/sandbox/do";
import { workPath } from "../src/sandbox/client";
import { RegistryDO } from "../src/registry";
import { ThreadDO } from "../src/thread";
import { SandboxFleetDO, type CatalogEntry } from "../src/remote-sandbox/fleet";
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
  it("offers only Code Mode for sandbox tools in owner turns", async () => {
    const seen = scriptedModel([{ name: "", args: {} }, { name: "", args: {} }]);
    expect(await env.THREAD.getByName("owner").submit(input(1, "写个脚本", 10000001))).toEqual({ status: "done" });
    expect(seen.requests[0]!.tools).toContain("codemode");
    for (const name of [...CODING_TOOLS, "skill_inspect", "skill_publish"]) expect(seen.requests[0]!.tools).not.toContain(name);
    expect(await env.THREAD.getByName("group:200000001").submit(input(2, "跑个脚本", 10000003, 200000001, true))).toEqual({ status: "done" });
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
  });

  it("lists, acquires and calls a registered WSB tool in one Code Mode script", async () => {
    vi.spyOn(RegistryDO.prototype, "mcpConfig").mockReturnValue({ ...MCP_CONFIG, enabled: false, servers: [] });
    const deviceId = "11111111-1111-1111-1111-111111111111", sandboxId = "remote:" + deviceId, revision = "a".repeat(64);
    const resource: CatalogEntry = { id: sandboxId, name: "WSB", provider: "windows-sandbox", os: "windows", arch: "x64",
      tools: [{ name: "powershell", description: "执行 PowerShell", inputSchema: { type: "object", properties: { script: { type: "string" } }, required: ["script"] } }],
      memoryMiB: 4096, maxTimeoutMs: 120000, capabilityRevision: revision, availability: "ready", activeJobs: 0,
      workspaceRoot: "C:\\AgentWork", persistence: "lease", mismatch: [] };
    vi.spyOn(SandboxFleetDO.prototype, "catalogJson").mockResolvedValue(JSON.stringify([resource]));
    vi.spyOn(SandboxFleetDO.prototype, "sessions").mockResolvedValue([]);
    const workspace = env.SANDBOX.idFromName("owner").toString();
    vi.spyOn(SandboxFleetDO.prototype, "acquire").mockResolvedValue({ id: "lease-one", deviceId, sandboxId, workspace,
      operationId: "fixture", capabilityRevision: revision, requirements: {}, createdAt: 1 });
    const invoke = vi.spyOn(SandboxFleetDO.prototype, "invoke").mockResolvedValue({ jobId: "job-one", phase: "dispatched" });
    const seen = scriptedModel([{ name: "codemode", args: { code: 'const list=await tools.sandbox_list({}); const target=list.sandboxes[0]; const lease=await tools.sandbox_acquire({sandboxId:target.id,capabilityRevision:target.capabilityRevision}); text(await tools.sandbox_call({leaseId:lease.id,tool:target.tools[0].name,arguments:{script:"Write-Output hello"}}));' } }]);
    await runInDurableObject(env.THREAD.getByName("owner"), async (_instance, state) => {
      await new ThreadDO(state, { ...env, REMOTE_SANDBOX_ENABLED: "true", MEMORY_EXTRACT_NAMESPACES: "" }).submit(input(1, "远程运行", 10000001));
    });
    expect(invoke, seen.outputs.join("\n")).toHaveBeenCalledWith(workspace, expect.stringMatching(/^task:/), { leaseId: "lease-one", tool: "powershell", arguments: { script: "Write-Output hello" }, timeoutMs: 120000 });
    expect(seen.outputs.join("\n")).toContain("job-one");
    for (const name of ["sandbox_list", "sandbox_acquire", "sandbox_call", "sandbox_job", "sandbox_release"]) expect(seen.requests[0]!.tools).not.toContain(name);
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
      await new ThreadDO(state, currentEnv).submit(input(1, "运行", 10000001));
      expect(exec).toHaveBeenCalledTimes(1);
    });
    expect(seen.outputs.join("\n")).toContain("只有主人");
  });

  it("refuses sandbox calls in event turns even when Code Mode is available", async () => {
    const exec = vi.spyOn(SandboxDO.prototype, "exec");
    const seen = scriptedModel([{ name: "codemode", args: { code: 'text(await tools.bash({command:"forbidden"}));' } }]);
    await env.THREAD.getByName("owner").submit({ ...input(1, "事件", 10000001), kind: "event" });
    expect(exec).not.toHaveBeenCalled();
    expect(seen.outputs.join("\n")).toContain("只有主人");
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
  it("shows the owner sandbox state and maps a reset without containers to 503", async () => {
    const overview = await (await admin("GET", "/admin/overview")).json<{ threads: { key: string; sandbox?: string }[] }>();
    expect(overview.threads.find(thread => thread.key === "owner")?.sandbox).toBe("unavailable");
    const response = await admin("POST", "/admin/threads/owner/sandbox/reset");
    expect([response.status, await response.json()]).toEqual([503, { error: "sandbox_unavailable" }]);
    expect((await admin("POST", "/admin/threads/nobody/sandbox/reset")).status).toBe(404);
  });
});
