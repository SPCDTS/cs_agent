import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { SandboxDO } from "../src/sandbox/do";
import { CLOUDFLARE_INSTRUCTIONS, CLOUDFLARE_RESOURCE_INSTRUCTIONS } from "../src/sandbox/registration";
import { workPath } from "../src/sandbox/client";
import { RegistryDO } from "../src/registry";
import { BridgeDO } from "../src/bridge";
import { threadWithBindings } from "./thread-fixture";
import { MCP_CONFIG } from "../src/mcp/config";
import type { SkillSummary } from "../src/skills";
import { scriptedModel } from "./events-helpers";
import { input } from "./helpers";
import { createModels } from "@earendil-works/pi-ai/models";
import type { JsonObject } from "@earendil-works/pi-durable";
import { fauxProvider, fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import * as models from "../src/models";

describe("coding tools suite", () => {
  let seq = 0;
  const nextInput = (text: string, userId = 10000001, groupId?: number, mention = false) => input(++seq, text, userId, groupId, mention);
  
  afterEach(async () => {
    await reset();
    vi.restoreAllMocks();
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
      await env.THREAD.getByName("owner").submit(nextInput("生成完整输出", 10000001));
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
        await threadWithBindings(instance, state, currentEnv).submit(nextInput("截图", 10000001));
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
      await env.THREAD.getByName(group ? "group:200000001" : "owner").submit(nextInput("发送图片", group ? 10000004 : 10000001, group ? 200000001 : undefined, group));
      expect(exported).not.toHaveBeenCalled();
      expect(seen.outputs.join("\n")).toContain(group ? "permission_denied" : "invalid_request");
    });
    it("owner 与群成员获得 CodeMode、网页读取和生图，沙箱工具只经 CodeMode 暴露", async () => {
      const seen = scriptedModel([{ name: "", args: {} }, { name: "", args: {} }]);
      expect(await env.THREAD.getByName("owner").submit(nextInput("写个脚本", 10000001))).toEqual({ status: "done" });
      expect(seen.requests[0]!.tools).toContain("codemode");
      expect(Object.values(seen.requests[0]!.sections)).toContain(`<sandbox>\n${CLOUDFLARE_INSTRUCTIONS}${CLOUDFLARE_RESOURCE_INSTRUCTIONS}\n</sandbox>`);
      for (const name of [...CODING_TOOLS, "skill_inspect", "skill_publish"]) expect(seen.requests[0]!.tools).not.toContain(name);
      expect(await env.THREAD.getByName("group:200000001").submit(nextInput("跑个脚本", 10000004, 200000001, true))).toEqual({ status: "done" });
      expect(Object.values(seen.requests[1]!.sections)).toContain(`<sandbox>\n${CLOUDFLARE_INSTRUCTIONS}\n</sandbox>`);
      for (const name of CODING_TOOLS) expect(seen.requests[1]!.tools).not.toContain(name);
      for (const request of seen.requests) expect(request.tools).toEqual(expect.arrayContaining(["codemode", "web_page", "generate_image"]));
    });
  
    it("runs nested sandbox calls with MCP disabled and gives each call its own task ID", async () => {
      vi.spyOn(RegistryDO.prototype, "mcpConfig").mockReturnValue({ ...MCP_CONFIG, enabled: false, servers: [] });
      const exec = vi.spyOn(SandboxDO.prototype, "exec").mockResolvedValue({ stdout: "ok", stderr: "", code: 0, timedOut: false, truncated: false });
      const seen = scriptedModel([{ name: "codemode", args: { code: 'text(await tools.bash({command:"one"})); text(await tools.bash({command:"two"}));' } }]);
      expect(await env.THREAD.getByName("owner").submit(nextInput("运行", 10000001))).toEqual({ status: "done" });
      expect(exec).toHaveBeenCalledTimes(2);
      expect(exec.mock.calls[0]![1]!.operationId).not.toBe(exec.mock.calls[1]![1]!.operationId);
      expect(seen.outputs.join("\n")).toContain("ok");
      const store = env.REQUESTS.getByName("main"), page = await store.list({ since: 0, until: Date.now() + 1000, limit: 10 });
      const request = page.requests.find(row => row.actor === "thread" && row.toolCalls?.some(call => call.name === "codemode"));
      expect(request).toBeDefined();
      const detail = await store.detail(request!.id), root = detail!.tools.find(tool => tool.name === "codemode")!;
      expect(detail!.tools.filter(tool => tool.parentCallId === root.callId).map(tool => tool.argumentPreview).sort()).toEqual(["command: one", "command: two"]);
      const observations=(await store.agentTraceDetail("owner",root.binding.turnId)).observations;
      expect(observations.find(row=>row.id===request!.id)?.calls).toContain(root.callId);
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
      await env.THREAD.getByName("owner").submit(nextInput("查看图片", 10000001));
      expect(images).toContain(data);
    });
  
    it("refuses direct model sandbox calls", async () => {
      const exec = vi.spyOn(SandboxDO.prototype, "exec");
      scriptedModel([{ name: "bash", args: { command: "must-not-run" } }]);
      await env.THREAD.getByName("owner").submit(nextInput("运行", 10000001));
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
        await threadWithBindings(_instance, state, currentEnv).submit(nextInput("运行", 10000001));
        expect(exec).toHaveBeenCalledTimes(1);
      });
      expect(seen.outputs.join("\n")).toContain("本回合无权使用沙箱工具");
    });
  
    it("refuses sandbox calls in event turns even when Code Mode is available", async () => {
      const exec = vi.spyOn(SandboxDO.prototype, "exec");
      const seen = scriptedModel([{ name: "codemode", args: { code: 'text(await tools.bash({command:"forbidden"}));' } }]);
      await env.THREAD.getByName("owner").submit({ ...nextInput("事件", 10000001), kind: "event" });
      expect(exec).not.toHaveBeenCalled();
      expect(seen.outputs.join("\n")).toContain("本回合无权使用沙箱工具");
    });
  
    it("tells the model the sandbox is unavailable and audits only the classification", async () => {
      const seen = scriptedModel([{ name: "codemode", args: { code: 'text(await tools.bash({command:"cat 秘密文件.txt"}));' } }, { name: "codemode", args: { code: 'text(await tools.write({path:"out/a.txt",content:"机密内容"}));' } }, { name: "", args: {} }]);
      expect(await env.THREAD.getByName("owner").submit(nextInput("跑一下", 10000001))).toEqual({ status: "done" });
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
      expect(await env.THREAD.getByName("owner").submit(nextInput("编译", 10000001))).toEqual({ status: "done" });
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
      expect(await env.THREAD.getByName("owner").submit(nextInput("改一下", 10000001))).toEqual({ status: "done" });
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
    expect(await env.THREAD.getByName("owner").submit(nextInput("创建独立沙箱", 10000001))).toEqual({ status: "done" });
    expect(seen.outputs.join("\n")).toContain('"kind":"cloudflare"');
    expect(targets).toHaveLength(2);
    expect(targets[0]).not.toBe(targets[1]);
    expect(targets[1]).toBe("workspace:" + env.SANDBOX.idFromName("owner"));
  });
});

describe("skills suite", () => {
  const TOKEN = "test-admin-only";
  beforeEach(async () => { await reset(); });
  afterEach(async () => { await reset(); vi.restoreAllMocks(); });
  
  function admin(method: string, path: string, body?: unknown, token: string | null = TOKEN) {
    const headers: Record<string, string> = {};
    if (token !== null) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    return worker.fetch(new Request(`https://test${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), { ...env, ADMIN_TOKEN: TOKEN });
  }
  const skillMd = (name: string, description = "压枪与急停的练习步骤") => `---\nname: ${name}\ndescription: ${description}\n---\n# 练枪\n先练急停，再练压枪。\n`;
  const digest = () => env.REGISTRY.getByName("main").skillsDigest();
  async function put(name: string, body: unknown) {
    const response = await admin("PUT", `/admin/skills/${name}`, body);
    return { status: response.status, body: await response.json<Record<string, unknown>>() };
  }
  
  /** 记录每次模型请求时生效的 skills section（按系统消息重放，null 表示已撤下）与工具结果。 */
  function script(steps: { name: string; args: JsonObject }[]) {
    const faux = fauxProvider({ models: [{ id: "test" }], tokensPerSecond: Infinity });
    const outputs: string[] = [], sections: (string | null | undefined)[] = [], tools = new Set<string>(), captured = new Set<string>();
    const respond: FauxResponseFactory = transcript => {
      faux.setResponses([respond]);
      let skills: string | null | undefined;
      for (const message of transcript.messages) if (message.role === "system") {
        if (message.sections && "skills" in message.sections) skills = message.sections.skills;
        for (const tool of message.toolsAdded ?? []) tools.add(tool.name);
      }
      sections.push(skills);
      const last = transcript.messages.findLast(message => message.role === "toolResult");
      if (last?.role === "toolResult" && !captured.has(last.toolCallId)) {
        captured.add(last.toolCallId);
        outputs.push(last.content.filter(block => block.type === "text").map(block => block.text).join(""));
      }
      const next = transcript.messages.at(-1)?.role === "assistant" ? undefined : steps.shift();
      return next ? fauxAssistantMessage(fauxToolCall(next.name, next.args), { stopReason: "toolUse" }) : fauxAssistantMessage("done");
    };
    faux.setResponses([respond]);
    vi.spyOn(models, "openModels").mockImplementation(() => {
      const registry = createModels(); registry.setProvider(faux.provider);
      return registry;
    });
    return { outputs, sections, tools, steps };
  }
  // 每回合新建 ThreadDO 实例：实例里的目录缓存是 60 秒，新实例代表缓存过期后的下一次请求。
  const turn = (key: string, messageId: number, userId: number, groupId?: number) => runInDurableObject(env.THREAD.getByName(key),
    (_instance, state) => threadWithBindings(_instance, state, { ...env, MEMORY_EXTRACT_NAMESPACES: "" }).submit(input(messageId, "按技能练枪", userId, groupId)));
  
  describe("skills catalog", () => {
    it("validates PUT, keeps attachments and enablement on overwrite, and changes the digest only with the enabled catalog", async () => {
      expect((await admin("GET", "/admin/skills", undefined, null)).status).toBe(401);
      expect(await put("Bad_Name", { markdown: skillMd("Bad_Name") })).toEqual({ status: 400, body: { error: "invalid_name" } });
      expect(await put("aim", { markdown: skillMd("spray") })).toEqual({ status: 400, body: { error: "name_mismatch" } });
      expect(await put("aim", { markdown: "# 没有 frontmatter" })).toEqual({ status: 400, body: { error: "missing_frontmatter" } });
      expect(await put("aim", { markdown: "---\nname: aim\n---\n正文" })).toEqual({ status: 400, body: { error: "missing_description" } });
      expect(await put("aim", { markdown: skillMd("aim"), files: { "ref.md": "字".repeat(30_000) } })).toEqual({ status: 400, body: { error: "file_too_large" } });
      expect(await put("aim", { markdown: skillMd("aim"), files: { "../ref.md": "x" } })).toEqual({ status: 400, body: { error: "invalid_path" } });
      expect(await put("aim", { markdown: skillMd("aim"), files: { "/ref.md": "x" } })).toEqual({ status: 400, body: { error: "invalid_path" } });
      expect((await admin("GET", "/admin/skills")).status).toBe(200);
      expect(await (await admin("GET", "/admin/skills")).json()).toEqual({ skills: [] });
  
      const empty = await digest();
      expect(await put("aim", { markdown: skillMd("aim"), files: { "ref/notes.md": "急停要点" } }))
        .toEqual({ status: 200, body: { name: "aim", description: "压枪与急停的练习步骤", enabled: true, updatedAt: expect.any(Number), files: ["ref/notes.md"] } });
      const withAim = await digest();
      expect(withAim).not.toBe(empty);
      const list = await (await admin("GET", "/admin/skills")).json<{ skills: (SkillSummary & { body?: string })[] }>();
      expect(list.skills).toHaveLength(1);
      expect(list.skills[0]).not.toHaveProperty("body");
  
      expect((await admin("POST", "/admin/skills/aim/disable")).status).toBe(200);
      expect(await digest()).toBe(empty);
      // 停用期间改正文：仍停用、附件保留；正文变了但目录（名称与描述）没变，digest 不变。
      expect((await put("aim", { markdown: skillMd("aim") + "补充一段。" })).body).toMatchObject({ enabled: false, files: ["ref/notes.md"] });
      expect(await digest()).toBe(empty);
      expect((await admin("POST", "/admin/skills/aim/enable")).status).toBe(200);
      expect(await digest()).toBe(withAim);
      expect((await put("aim", { markdown: skillMd("aim", "新的描述") })).status).toBe(200);
      expect(await digest()).not.toBe(withAim);
      expect(await (await admin("GET", "/admin/skills/aim")).json()).toMatchObject({ body: skillMd("aim", "新的描述"), files: { "ref/notes.md": "急停要点" } });
  
      expect((await admin("DELETE", "/admin/skills/aim")).status).toBe(200);
      expect((await admin("DELETE", "/admin/skills/aim")).status).toBe(404);
      expect((await admin("POST", "/admin/skills/aim/enable")).status).toBe(404);
      expect((await admin("GET", "/admin/skills/aim")).status).toBe(404);
      expect(await digest()).toBe(empty);
    });
  
    it("lists enabled skills in the skills section, serves read_skill with truncation, and drops a disabled skill", async () => {
      const long = "a".repeat(30_000);
      expect((await put("aim", { markdown: skillMd("aim"), files: { "ref/notes.md": "急停要点", "long.txt": long } })).status).toBe(200);
      expect((await put("spray", { markdown: skillMd("spray", "<控枪> & 弹道") })).status).toBe(200);
      expect((await admin("POST", "/admin/skills/spray/disable")).status).toBe(200);
      const seen = script([
        { name: "read_skill", args: { name: "aim" } },
        { name: "read_skill", args: { name: "aim", path: "ref/notes.md" } },
        { name: "read_skill", args: { name: "aim", path: "long.txt" } },
        { name: "read_skill", args: { name: "aim", path: "missing.md" } },
        { name: "read_skill", args: { name: "nobody" } },
        { name: "read_skill", args: { name: "spray" } },
      ]);
      expect(await turn("owner", 1, 10000001)).toEqual({ status: "done" });
      expect(seen.tools).toContain("read_skill");
      expect(seen.outputs[0]).toBe(skillMd("aim"));
      expect(seen.outputs[1]).toBe("急停要点");
      expect(seen.outputs[2]).toBe("a".repeat(20_000) + "\n…（已截断，全文 30000 字）");
      expect(seen.outputs[3]).toContain("没有文件 missing.md");
      expect(seen.outputs[3]).toContain("ref/notes.md");
      expect(seen.outputs[4]).toBe("技能 nobody 不存在或已停用。");
      expect(seen.outputs[5]).toBe("技能 spray 不存在或已停用。");
      const section = seen.sections.at(-1);
      expect(section).toContain("<available_skills>");
      expect(section).toContain("<name>aim</name>\n<description>压枪与急停的练习步骤</description>");
      expect(section).not.toContain("spray");
      expect(section).not.toContain("先练急停");
  
      expect((await admin("POST", "/admin/skills/aim/disable")).status).toBe(200);
      seen.steps.push({ name: "read_skill", args: { name: "aim" } });
      seen.outputs.length = 0;
      expect(await turn("owner", 2, 10000001)).toEqual({ status: "done" });
      expect(seen.sections.at(-1) ?? null).toBeNull();
      expect(seen.outputs[0]).toBe("技能 aim 不存在或已停用。");
    });
  
    it("serves the same catalog and read_skill in group threads", async () => {
      expect((await put("aim", { markdown: skillMd("aim") })).status).toBe(200);
      const seen = script([{ name: "read_skill", args: { name: "aim" } }]);
      expect(await turn("group:200000001", 1, 10000004, 200000001)).toEqual({ status: "done" });
      expect(seen.outputs[0]).toBe(skillMd("aim"));
      expect(seen.sections.at(-1)).toContain("<name>aim</name>");
    });
  });
});
