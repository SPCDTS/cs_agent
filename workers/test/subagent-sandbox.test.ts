import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RegistryDO } from "../src/registry";
import { SandboxDO } from "../src/sandbox/do";
import { ThreadDO } from "../src/thread";
import { MCP_CONFIG } from "../src/mcp/config";
import { workspaceView } from "../src/admin/read-views";
import { fakeRemote, login } from "./mcp-helpers";
import { action, connect, input, reply, syncedView } from "./helpers";
import { child, gate, idOf, onlySubagent, reports, rows, seedPublishSkill, spawn, thread, twoModels, type Step } from "./subagent-fixture";

const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  await reset();
  vi.restoreAllMocks();
});

describe("subagent sandbox, MCP and delegation boundaries", () => {
  it.each(["qq", "web"] as const)("continues the parent's sandbox task after a %s child report with MCP disabled", async channel => {
    const ready = gate();
    await seedPublishSkill();
    await seedPublishSkill("group:200000001");
    const exec = vi.spyOn(SandboxDO.prototype, "exec").mockResolvedValue({ stdout: "主会话命令成功", stderr: "", code: 0, timedOut: false, truncated: false });
    vi.spyOn(RegistryDO.prototype, "mcpConfig").mockReturnValue({ ...MCP_CONFIG, enabled: false, servers: [] });
    const { outputs } = twoModels([spawn("检查独立工作区"), { text: "已派出" },
      { tool: "codemode", args: { code: 'text((await tools.sandbox_list({})).assignedSandboxId);' } },
      { tool: "codemode", args: { code: 'text(await tools.bash({command:"pwd"}));' } },
      { tool: "codemode", args: { code: 'const check=await tools.skill_inspect({path:"skills/example"});text(await tools.skill_publish({path:"skills/example",workspaceRevision:check.workspaceRevision,expectedRevision:check.expectedRevision}));text((await tools.read({workspace:"group:200000001",path:"skills/example/sources.md"})).text);' } },
      { tool: "codemode", args: { code: 'text(await tools.edge_grant({from:"owner",to:"private:42"}));' } },
      { text: "已核实主工作区" },
    ], [{ text: "子工作区为空，请主会话核实", after: ready.promise }]);
    if (channel === "web") {
      await thread("owner").submitWeb("owner", crypto.randomUUID(), "检查主工作区");
      await vi.waitFor(async () => expect(await rows("owner", "SELECT 1 FROM inbound WHERE kind='message' AND status='done'")).toHaveLength(1));
    } else await thread("owner").submit(input(1, "检查主工作区", 10000001));
    await onlySubagent("owner");
    ready.open();
    await reports("owner", 1);
    expect(outputs.parent[1]).toContain("sbx:");
    expect(outputs.parent[2]).toContain("主会话命令成功");
    expect(exec).toHaveBeenCalledTimes(1);
    expect(outputs.parent[3]).toContain('"ok":true');
    expect(outputs.parent[3]).toContain("中文来源说明");
    expect(outputs.parent[4]).toContain("仅限 owner");
    expect(await env.REGISTRY.getByName("main").edgeAllowed("owner", "private:42")).toBe(false);
    expect((await env.REGISTRY.getByName("main").skillGet("example"))?.files).toEqual({ "sources.md": "中文来源说明" });
  });

  it("撤销原任务后父会话续轮不能发布技能", async () => {
    await seedPublishSkill();
    const ready = gate(), resume = gate();
    vi.spyOn(RegistryDO.prototype, "mcpConfig").mockReturnValue({ ...MCP_CONFIG, enabled: false, servers: [] });
    const { outputs, seen } = twoModels([spawn("检查技能"), { text: "已派出" },
      { tool: "codemode", after: resume.promise, args: { code: 'text(await tools.skill_publish({path:"skills/example",workspaceRevision:"x",expectedRevision:"absent"}));' } },
      { text: "授权已撤销" }], [{ text: "请主会话发布", after: ready.promise }]);
    await thread("owner").submit(input(1, "检查并发布技能", 10000001));
    ready.open();
    await vi.waitFor(() => expect(seen.parent.some(r => r.user.startsWith("[子 agent 完成]"))).toBe(true));
    await rows("owner", "UPDATE sandbox_tasks SET revoked_at=1");
    resume.open();
    await reports("owner", 1);
    expect(outputs.parent[1]).toContain("denied");
    expect(await env.REGISTRY.getByName("main").skillGet("example")).toBeUndefined();
  });

  it.each(["capability", "identity", "generation", "cancelled", "channel", "task"] as const)("rechecks %s before a parent report turn uses the sandbox", async change => {
    const childReady = gate(), resume = gate();
    const exported = vi.spyOn(SandboxDO.prototype, "exportAsset");
    vi.spyOn(RegistryDO.prototype, "mcpConfig").mockReturnValue({ ...MCP_CONFIG, enabled: false, servers: [] });
    const { outputs, seen } = twoModels([spawn("检查工作区"), { text: "已派出" },
      { tool: "codemode", after: resume.promise, args: { code: 'text(await tools.sandbox_list({}));' } },
      { tool: "send_file", args: { path: "/work/.codemode/image.png" } }, { text: "权限已失效" },
    ], [{ text: "请主会话继续检查", after: childReady.promise }]);
    await thread("owner").submit(input(1, "检查工作区", 10000001));
    const sub = await onlySubagent("owner");
    childReady.open();
    await vi.waitFor(() => expect(seen.parent.some(request => request.user.startsWith("[子 agent 完成]"))).toBe(true));
    switch (change) {
      case "capability": await rows("owner", "UPDATE subagents SET origin_json=json_set(origin_json, '$.capabilities.coding', json('false')) WHERE id=?", sub.id); break;
      case "identity": await rows("owner", "UPDATE subagents SET identity_json=json_remove(identity_json, '$.as') WHERE id=?", sub.id); break;
      case "generation": await rows("owner", "UPDATE subagents SET origin_json=json_set(origin_json, '$.generation', 1) WHERE id=?", sub.id); break;
      case "cancelled": await rows("owner", "UPDATE subagents SET status='cancelled' WHERE id=?", sub.id); break;
      case "channel": await rows("owner", "UPDATE subagents SET origin_json=json_set(origin_json, '$.replyChannel', 'web') WHERE id=?", sub.id); break;
      case "task": await rows("owner", "UPDATE sandbox_tasks SET revoked_at=1"); break;
    }
    resume.open();
    await reports("owner", 1);
    expect(outputs.parent[1]).toContain("denied");
    expect(outputs.parent[2]).toContain("本回合无权访问媒体或发送附件");
    expect(exported).not.toHaveBeenCalled();
  });

  it("uses spawn.mcpTools and preserves structured results through child Code Mode", async () => {
    const remote = fakeRemote(); await login();
    remote.state.tools = [
      ...remote.state.tools.slice(0, 2),
      { name: "notion-create-pages", inputSchema: { type: "object" },
        outputSchema: { type: "object", properties: { requestId: { type: "string" } }, required: ["requestId"], additionalProperties: false } },
    ];
    remote.state.toolResult = { structuredContent: { requestId: "child-job-42" }, content: [{ type: "text", text: "dispatched" }] };
    const { outputs } = twoModels([
      spawn("交给子代理发起作业", { mcpTools: [{ server: "notion", tools: ["notion-create-pages"] }] }), { text: "已派出" },
    ], [
      { tool: "codemode", args: { code: 'const names=ALL_TOOLS.map(tool=>tool.name); text(names); const tool=names.find(name=>name.startsWith("mcp_notion_notion_create_pages_")); const result=await tools[tool]({}); text(result.structuredContent.requestId);' } },
      { text: "作业已发起" },
    ]);
    expect(await thread("owner").refreshMcp()).toEqual(expect.arrayContaining([expect.objectContaining({ server: "notion", status: "ok" })]));
    await thread("owner").submit(input(1, "派发作业", 10000001));
    await reports("owner", 1);
    expect(outputs.child[0]).toContain("child-job-42");
    expect(outputs.child[0]).not.toMatch(/mcp_notion_notion_(search|fetch)_|mcp_resources_/);
    expect(remote.state.calls).toBe(1);
  });

  it("子 agent 的 CodeMode 内部调用、捕获的失败和后续输入都归入独立执行组", async () => {
    vi.spyOn(SandboxDO.prototype, "run").mockImplementation(async function(this: SandboxDO, input) {
      if (input.operation.kind === "exec" && input.operation.command === "fail") throw Error("fixture_execution_failed");
      return { status: "committed", persistence: "committed", revision: (await this.files()).revision,
        result: { stdout: "少量输出", stderr: "", code: 0, timedOut: false, truncated: false } };
    });
    twoModels([spawn("执行两个命令"), { text: "已派出" }, { text: "收到结果" }], [
      { tool: "codemode", args: { code: 'try { await tools.bash({command:"fail"}); } catch {} text(await tools.bash({command:"ok"}));' } }, { text: "处理完毕" },
    ]);
    await thread("owner").submit(input(1, "运行检查", 10000001));
    await reports("owner", 1);
    const agent = await onlySubagent("owner"), store = env.REQUESTS.getByName("main");
    const page = await store.list({ since: 0, until: Date.now() + 1000, limit: 20 });
    const request = page.requests.find(row => row.actor === agent.id && row.toolCalls?.some(call => call.name === "codemode"));
    expect(request?.binding?.turnId).toContain("turn:sub:" + agent.id + ":");
    const detail = await store.detail(request!.id), root = detail!.tools.find(tool => tool.name === "codemode")!;
    expect(root.status, JSON.stringify(await store.toolDetail(root.id))).toBe("done");
    expect(detail!.tools.every(tool => tool.actor === agent.id)).toBe(true);
    expect(detail!.tools.filter(tool => tool.parentCallId === root.callId).map(tool => tool.status).sort()).toEqual(["done", "error"]);
    const followup = page.requests.find(row => row.actor === agent.id && row.purpose === "subagent" && !row.toolCalls?.length);
    const inspection = await store.contextInspection(followup!.id), item = inspection?.analysis?.items.find(item => item.execution);
    expect(item?.execution).toMatchObject({ calls: 2, failures: 1, label: "bash ×2" });
    expect((await store.toolExecution(root.id))?.sourceRequestId).toBe(request!.id);
    expect(inspection?.analysis?.metrics.chars.result).toBeLessThan(1000);
  });

  it.each([false, true])("子 agent 自动输出沿用分配资源，父 agent 可按 ID 核对原图再发送，shared=%s", async shared => {
    const resources = env.CLOUDFLARE_WORKSPACE_RESOURCES.getByName("owner"), { assignedSandboxId } = await resources.list("owner");
    const resource = shared ? await resources.get("owner", assignedSandboxId) : await resources.create("owner", "image-env", {});
    if (!resource) throw Error("missing_resource");
    const data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aH1sAAAAASUVORK5CYII=", png = Uint8Array.from(atob(data), char => char.charCodeAt(0));
    let savedPath = "";
    const { outputs, seen } = twoModels([spawn("截图", shared ? {} : { sandboxId: resource.id }), { text: "已派出" },
      () => ({ tool: "codemode", args: { code: `const preview = await tools.r2_read(${JSON.stringify({ sandboxId: resource.id, key: savedPath })}); text(preview.image.data);` } }),
      () => ({ tool: "send_file", args: { sandboxId: resource.id, path: savedPath } })], [
      { tool: "codemode", args: { code: `image({type:"image",data:${JSON.stringify(data)},mimeType:"image/png"});` } },
      results => { savedPath = /Image saved to (r2:\/\/[^\s]+\.png)/.exec(results.join("\n"))?.[1] ?? ""; return { text: savedPath }; },
    ]);
    const { socket, frames } = await connect(sockets);
    await thread("owner").submit(input(1, "截图后发给我", 10000001));
    await vi.waitFor(() => expect(outputs.child.length).toBeGreaterThan(0));
    expect(outputs.child.join("\n")).toContain("Image saved to");
    reply(socket, (await action(frames, 0, "send_private_msg")).echo);
    await reports("owner", 1);
    expect(outputs.child.join("\n")).toContain("Image saved to");
    expect(seen.child[0]!.tools).not.toContain("send_file");
    expect(outputs.parent.join("\n")).toContain(data);
    expect(await env.SANDBOX.getByName(resource.name).readObject(savedPath)).toEqual(png);
    const sub = await onlySubagent("owner");
    await expect((async () => await thread("owner").subagentWriteObject(sub.id, savedPath, png))()).rejects.toThrow("delegation_denied");
  });

  it("子 agent 按资源 ID 路由；省略时继承默认资源，多个子任务可以共用新资源", async () => {
    await seedPublishSkill();
    const resources = env.CLOUDFLARE_WORKSPACE_RESOURCES.getByName("owner");
    const { assignedSandboxId } = await resources.list("owner");
    const current = (await resources.get("owner", assignedSandboxId))!;
    const created = await resources.create("owner", "new-cf", { sourceId: current.id });
    const targets: string[] = [];
    vi.spyOn(SandboxDO.prototype, "run").mockImplementation(async function(this: SandboxDO) {
      const files = await this.files(); targets.push(files.workspace);
      return { status: "committed", persistence: "committed", revision: files.revision, result: { bytes: 4 } };
    });
    const clone = vi.spyOn(SandboxDO.prototype, "cloneFrom");
    twoModels([spawn("默认资源"), { text: "已分配" }, { text: "收到" }, spawn("新资源甲", { sandboxId: created.id }), { text: "已分配" }, { text: "收到" }, spawn("新资源乙", { sandboxId: created.id }), { text: "已分配" }],
      Array.from({ length: 3 }, (): Step[] => [{ tool: "codemode", args: { code: 'text(await tools.write({path:"marker",content:"same"}));' } }, { text: "已完成" }]).flat());
    await thread("owner").submit(input(1, "按资源分配三个子任务", 10000001));
    await reports("owner", 1);
    await thread("owner").submit(input(2, "分配第二个子任务", 10000001));
    await reports("owner", 2);
    await thread("owner").submit(input(3, "分配第三个子任务", 10000001));
    await reports("owner", 3);
    const list = await (await syncedView("owner")).subagentList();
    const ids = await Promise.all(list.map(async sub => (await child("owner", sub.id).status())?.meta.capabilities?.sandboxId));
    expect(ids.sort()).toEqual([current.id, created.id, created.id].sort());
    expect(clone).not.toHaveBeenCalled();
    expect(targets).toEqual([current.name, created.name, created.name].map(name => "workspace:" + env.SANDBOX.idFromName(name)));
    expect((await env.SANDBOX.getByName(created.name).files()).files).toEqual((await env.SANDBOX.getByName(current.name).files()).files);
    const shared = list.find(sub => sub.task === "默认资源")!, manifest = await env.SANDBOX.getByName(current.name).files();
    await expect((async () => await thread("owner").workspaceMergeChild("owner", { childId: shared.id, expectedRevision: manifest.revision, sourceRevision: manifest.revision, paths: ["skills/example/sources.md"] }))()).rejects.toThrow("workspace_shared_resource");
  });

  it.each(["remote", "missing"])("旧子任务绑定的 %s ID 禁止回落到 Cloudflare", async kind => {
    const oldId = "sbx:" + "a".repeat(64);
    if (kind === "remote") {
      await runInDurableObject(env.CLOUDFLARE_WORKSPACE_RESOURCES.getByName("owner"), (_instance, state) =>
        state.storage.put("resource:" + oldId, { kind: "ready",
          resource: { id: oldId, owner: "owner", kind: "remote", providerId: "remote:test", workspace: "old" } }));
    }
    twoModels([spawn("历史任务"), { text: "已派出" }], ["hang"]);
    await thread("owner").submit(input(1, "分配任务", 10000001));
    const sub = await onlySubagent("owner");
    const [{ origin_json }] = await rows<{ origin_json: string }>("owner", "SELECT origin_json FROM subagents WHERE id=?", sub.id);
    const patched = JSON.parse(origin_json);
    patched.capabilities = { ...patched.capabilities, sandboxId: oldId };
    await rows("owner", "UPDATE subagents SET origin_json=? WHERE id=?", JSON.stringify(patched), sub.id);
    const run = vi.spyOn(SandboxDO.prototype, "run");
    expect(await thread("owner").validateSubagentAccess(sub.id)).toMatchObject({ capabilities: { sandboxId: oldId, coding: false } });
    const result = await runInDurableObject(thread("owner"), async instance => {
      if (!(instance instanceof ThreadDO)) throw new Error("wrong fixture");
      return (await instance.subagentCoding(sub.id, { kind: "read", operationId: "test", path: "file" })).isError;
    });
    expect(result).toBe(true);
    expect(run).not.toHaveBeenCalled();
    await thread("owner").syncAdminView("owner");
    await expect(workspaceView(env, "owner").inspectChild({ childId: sub.id })).rejects.toThrow("workspace_denied");
    await thread("owner").cancelSubagent(sub.id);
  });

  it("Cloudflare 克隆已提交而资源登记中断时，重试使用原快照且不重复导入", async () => {
    await seedPublishSkill();
    const resources = env.CLOUDFLARE_WORKSPACE_RESOURCES.getByName("owner");
    const { assignedSandboxId } = await resources.list("owner");
    const original = SandboxDO.prototype.cloneFrom;
    let committedRevision = "";
    vi.spyOn(SandboxDO.prototype, "cloneFrom").mockImplementationOnce(async function(this: SandboxDO, input) {
      const result = await original.call(this, input);
      if (result.ok) committedRevision = result.manifest.revision;
      throw new Error("interrupted_after_import");
    });
    const args = { sourceId: assignedSandboxId };
    await expect((async () => await resources.create("owner", "recover", args))()).rejects.toThrow("interrupted_after_import");
    await seedPublishSkill();
    const recovered = await resources.create("owner", "recover", args);
    expect((await env.SANDBOX.getByName(recovered.name).files()).revision).toBe(committedRevision);
    expect(await resources.create("owner", "recover", args)).toEqual(recovered);
  });

  it.each(["subagent", "agent_send"])("%s rejects a different member while the owner child is actually executing", async mode => {
    const running = gate(), group = "group:200000001";
    const { seen, outputs } = twoModels([
      spawn("owner-authorized-task"), { text: "spawned" },
      (out): Step => mode === "subagent" ? { tool: "subagent", args: { action: "message", id: idOf(out[0]), text: "FOREIGN-INJECTION" } }
        : { tool: "agent_send", args: { to: "sub:" + group + ":" + idOf(out[0]), text: "FOREIGN-INJECTION" } },
      { text: "rejected" }, { text: "owner report received" },
    ], [{ text: "owner-result", after: running.promise }]);
    await thread(group).submit(input(1, "start", 10000001, 200000001, true));
    const sub = await onlySubagent(group);
    await vi.waitFor(() => expect(seen.child).toHaveLength(1));
    const before = await child(group, sub.id).status();
    expect(before?.meta.status).toBe("running");
    try {
      await thread(group).submit(input(2, "foreign followup", 10000003, 200000001, true));
      expect(outputs.parent.join("\n")).toContain("agent_child_identity_denied");
      expect((await child(group, sub.id).status())?.meta.identity).toEqual(before?.meta.identity);
      await runInDurableObject(child(group, sub.id), (_i, s) => {
        expect(s.storage.sql.exec("SELECT text FROM inbox WHERE text LIKE '%FOREIGN-INJECTION%'").toArray()).toHaveLength(0);
      });
    } finally { running.open(); }
    const [report] = await reports(group, 1);
    expect(report?.user_id).toBe("10000001");
    expect(report?.text).toContain("owner-result");
    expect(seen.child.every(turn => !turn.user.includes("FOREIGN-INJECTION"))).toBe(true);
  });
});
