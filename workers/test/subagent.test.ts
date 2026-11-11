import { env, reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, fauxToolCall, fauxText, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import type { JsonObject } from "@earendil-works/pi-durable";
import worker from "../src/index";
import * as models from "../src/models";
import { RegistryDO } from "../src/registry";
import { SandboxDO } from "../src/sandbox/do";
import { ThreadDO } from "../src/thread";
import { scopePrefix } from "../src/media/repository";
import { sha256 } from "../src/media/model";
import { MCP_CONFIG } from "../src/mcp/config";
import { fakeRemote, login } from "./mcp-helpers";
import type { SubagentView } from "../src/subagent/parent";
import { responseDescription, shortSummary } from "../src/subagent/activity";
import { action, connect, input, reply } from "./helpers";
const TOKEN = "test-admin-only";
const sockets: WebSocket[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const socket of sockets.splice(0)) socket.close();
  await reset();
});

/** 一步：调工具、给最终文字（可等闸门打开再答）、或一直挂起到被中止；函数步按已有的工具输出求出下一步。 */
type Step = { tool: string; args: JsonObject; progress?: string; after?: Promise<void> } | { text: string; after?: Promise<void> } | "hang" | ((outputs: string[]) => Step);
type Seen = { tools: string[]; user: string; identity: string };

/** 父线程与子 agent 共用一个 faux provider；按系统段里有没有 subagent 段分流到各自的脚本。 */
function twoModels(parentSteps: Step[], childSteps: Step[]) {
  const faux = fauxProvider({ models: [{ id: "test" }], tokensPerSecond: Infinity });
  const seen = { parent: [] as Seen[], child: [] as Seen[] }, outputs = { parent: [] as string[], child: [] as string[] };
  const captured = new Set<string>();
  const respond: FauxResponseFactory = async (transcript, options) => {
    faux.setResponses([respond]);
    let role: "parent" | "child" = "parent", identity = "";
    const tools = new Set<string>();
    for (const message of transcript.messages) {
      if (message.role !== "system") continue;
      if (message.sections?.subagent) role = "child";
      if (message.sections && "turn-identity" in message.sections) identity = message.sections["turn-identity"] ?? "";
      for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
      for (const tool of message.toolsAdded ?? []) tools.add(tool.name);
    }
    for (const message of transcript.messages) if (message.role === "toolResult" && !captured.has(message.toolCallId)) {
      captured.add(message.toolCallId);
      outputs[role].push(message.content.filter(block => block.type === "text").map(block => block.text).join(""));
    }
    const user = transcript.messages.findLast(message => message.role === "user");
    seen[role].push({ tools: [...tools], identity,
      user: typeof user?.content === "string" ? user.content : user?.content.map(block => block.type === "text" ? block.text : "").join("") ?? "" });
    // 段落变化（如本回合身份）以系统消息追加在用户输入之后，按最后一条非系统消息判断轮到谁。
    const last = transcript.messages.findLast(message => message.role !== "system")?.role;
    let step = last === "user" || last === "toolResult" ? (role === "parent" ? parentSteps : childSteps).shift() : undefined;
    while (typeof step === "function") step = step(outputs[role]);
    if (step === "hang") {
      return new Promise((_resolve, reject) => {
        const signal = options?.signal;
        if (signal?.aborted) reject(new Error("aborted"));
        signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    }
    if (step) await step.after;
    if (step && "tool" in step) return fauxAssistantMessage([...(step.progress ? [fauxText(step.progress)] : []), fauxToolCall(step.tool, step.args)], { stopReason: "toolUse" });
    if (step) return fauxAssistantMessage(step.text);
    return fauxAssistantMessage("done");
  };
  faux.setResponses([respond]);
  vi.spyOn(models, "openModels").mockImplementation((_env, credentials) => {
    const registry = createModels({ credentials });
    registry.setProvider(faux.provider);
    return registry;
  });
  return { seen, outputs };
}

const thread = (key: string) => env.THREAD.getByName(key);
const child = (key: string, id: string) => env.SUBAGENT.getByName(`sub:${key}:${id}`);
const rows = <T>(key: string, query: string, ...args: (string | number)[]) => runInDurableObject(thread(key), (_instance, state) =>
  state.storage.sql.exec<T & Record<string, SqlStorageValue>>(query, ...args).toArray() as T[]);
const spawn = (task: string, extra: JsonObject = {}): Step => ({ tool: "subagent", args: { action: "spawn", task, ...extra } });
const idOf = (output: string | undefined) => /子 agent ([0-9a-f-]{36})/.exec(output ?? "")?.[1] ?? "";
async function onlySubagent(key: string): Promise<SubagentView> {
  const list = await thread(key).subagentList();
  expect(list).toHaveLength(1);
  return list[0]!;
}
async function reports(key: string, count: number) {
  await vi.waitFor(async () => expect(await rows(key, "SELECT 1 FROM inbound WHERE kind = 'subagent' AND status = 'done'")).toHaveLength(count), { timeout: 10_000 });
  return rows<{ message_id: string; text: string; turn_id: string; user_id: string }>(key, "SELECT * FROM inbound WHERE kind = 'subagent' ORDER BY rowid");
}
function gate() {
  let open = () => {};
  const promise = new Promise<void>(resolve => { open = resolve; });
  return { promise, open };
}
function admin(method: string, path: string, token: string | null = TOKEN) {
  return worker.fetch(new Request(`https://test${path}`, { method, headers: token === null ? {} : { Authorization: `Bearer ${token}` } }), { ...env, ADMIN_TOKEN: TOKEN });
}

async function seedPublishSkill(workspace = "owner") {
  const sandbox=env.SANDBOX.getByName(workspace),current=await sandbox.files();
  const texts={"skills/example/SKILL.md":"---\nname: example\ndescription: 测试技能发布\n---\n读取 sources.md。","skills/example/sources.md":"中文来源说明"};
  const files=await Promise.all(Object.entries(texts).map(async([path,text])=>{
    const bytes=new TextEncoder().encode(text),digest=await sha256(bytes);
    await env.ASSETS.put((await scopePrefix(current.workspace))+"/workspace/blobs/"+digest,bytes);
    return {path,sha256:digest,bytes:bytes.length,mime:"text/plain",mode:420};
  }));
  const result=await sandbox.importSnapshot({expectedRevision:current.revision,manifest:{...current,files,
    directories:["skills","skills/example"],totalBytes:files.reduce((sum,file)=>sum+file.bytes,0)}});
  expect(result.ok).toBe(true);
}

describe("subagents as child Durable Objects", () => {
  it("publishes task, progress and result summaries from the existing model turns", async () => {
    const answered = gate(), summary = "排查引用图片的读取链路";
    const { seen } = twoModels([spawn("读取最近消息，检查引用的图片能否读取。完整任务不进入拓扑。", { summary }), { text: "已派出" }, { text: "收到" }],
      [{ tool: "qq_context", args: {}, progress: "【进度】正在核对引用消息中的图片\n这里是详细说明，不进入概览。" },
        { text: "【结果】已确认引用消息可正常读取\n完整检查结果。", after: answered.promise }]);
    await thread("owner").submit(input(1, "检查图片", 10000001));
    const sub = await onlySubagent("owner"), store = env.REQUESTS.getByName("main");
    expect(sub.summary).toBe(summary);
    await vi.waitFor(async () => expect((await child("owner", sub.id).status())?.meta.progress?.text).toBe("正在核对引用消息中的图片"));
    const activity = async () => runInDurableObject(store, (_instance, state) => {
      const row = state.storage.sql.exec<{ record: string }>("SELECT record FROM agent_activity WHERE actor=?", sub.id).one();
      return JSON.parse(row.record);
    });
    await vi.waitFor(async () => expect(await activity()).toMatchObject({ summary, status: "running", description: { kind: "progress", text: "正在核对引用消息中的图片" } }));
    expect(JSON.stringify(await activity())).not.toMatch(/完整任务|详细说明/);
    answered.open();
    const [report] = await reports("owner", 1);
    expect(report.text).toContain("已确认引用消息可正常读取\n完整检查结果。");
    expect(report.text).not.toContain("【结果】");
    await vi.waitFor(async () => expect(await activity()).toMatchObject({ status: "done", description: { kind: "result", text: "已确认引用消息可正常读取" } }));
    expect(seen.child).toHaveLength(2);
    expect(seen.child[0].tools).not.toContain("update_progress");
  });

  it("falls back to task text without inventing progress or exposing credentials", () => {
    expect(shortSummary("检查图片。完整操作说明")).toBe("检查图片");
    expect(shortSummary("Authorization: Bearer secret-value")).not.toContain("secret-value");
    expect(responseDescription(fauxAssistantMessage("普通完整回答"), 1)).toBeUndefined();
    expect(responseDescription(fauxAssistantMessage("【进度】调用工具", { stopReason: "stop" }), 1)).toBeUndefined();
  });

  it("runs the task in its own DO with read-only tools and wakes the owner thread with the report", async () => {
    const { socket, frames } = await connect(sockets);
    const answered = gate();
    const { seen } = twoModels(
      [spawn("查一下 A 与 B 的区别"), { text: "已派出子 agent" }, { tool: "send_message", args: { text: "子 agent 查到了：A 更快" } }],
      [{ text: "调研结果：A 比 B 快", after: answered.promise }]);
    expect(await thread("owner").submit(input(1, "帮我查 A 和 B", 10000001))).toEqual({ status: "done" });
    answered.open();

    reply(socket, (await action(frames, 0, "send_private_msg")).echo);
    const [report] = await reports("owner", 1);
    const sub = await onlySubagent("owner");
    expect(report!.message_id).toBe(`subagent-report:${sub.id}:task`);
    expect(report!.text).toMatch(/^\[子 agent 完成\] id=[0-9a-f-]{36} 任务：查一下 A 与 B 的区别\n调研结果：A 比 B 快$/);
    const wake = seen.parent.find(request => request.user.startsWith("[子 agent 完成]"));
    expect(wake?.identity).toContain("本回合是子 agent 的汇报");
    expect(wake?.identity).toContain("派出者是 owner");

    // 汇报不进消息库，回合不参与记忆抽取；派出那一回合照常入抽取队列。
    expect(JSON.stringify(await rows("owner", "SELECT text FROM messages"))).not.toContain("调研结果");
    const extract = (await rows<{ turn_id: string }>("owner", "SELECT turn_id FROM extract_queue UNION SELECT turn_id FROM extract_receipts")).map(row => row.turn_id);
    expect(extract).not.toContain(report!.turn_id);
    const [spawnTurn] = await rows<{ turn_id: string }>("owner", "SELECT turn_id FROM inbound WHERE kind = 'message'");
    expect(extract).toContain(spawnTurn!.turn_id);

    const tools = seen.child[0]!.tools;
    expect(tools).toEqual(expect.arrayContaining(["web_search", "web_page", "qq_context", "mem_search"]));
    for (const name of ["send_message", "subagent", "generate_image", "mem_remember", "schedule", "gmail_send", "skill_inspect", "skill_publish"]) expect(tools).not.toContain(name);
    expect(seen.parent[0]!.tools).toContain("subagent");

    await vi.waitFor(async () => expect((await child("owner", sub.id).status())?.meta).toMatchObject({ status: "done", reportCount: 1 }));
    expect(sub).toMatchObject({ status: "done", spawner: "owner 10000001" });
    const audit = await rows<{ kind: string; detail: string }>("owner", "SELECT kind, detail FROM events WHERE kind LIKE 'subagent_%' ORDER BY kind");
    expect(audit.map(event => event.kind)).toEqual(["subagent_report", "subagent_spawn"]);
    expect(JSON.stringify(audit)).not.toMatch(/A 与 B|调研结果/);
  });

  it("delivers follow-up messages and processes each child request id once", async () => {
    twoModels(
      [spawn("先查 A"), { text: "已派出" }, { text: "收到第一轮" },
        outputs => ({ tool: "subagent", args: { action: "message", id: idOf(outputs[0]), text: "再查 C" } }), { text: "已追加" }],
      [{ text: "第一轮：A 很快" }, { text: "第二轮：C 最慢" }, { text: "第三轮：直接追加的回答" }]);
    expect(await thread("owner").submit(input(1, "查 A", 10000001))).toEqual({ status: "done" });
    await reports("owner", 1);
    expect(await thread("owner").submit(input(2, "再让它查 C", 10000001))).toEqual({ status: "done" });
    const second = await reports("owner", 2);
    expect(second[1]!.text).toContain("第二轮：C 最慢");

    const sub = await onlySubagent("owner"), stub = child("owner", sub.id);
    expect(sub.deadline).toBeNull();
    expect((await stub.message("dup-1", "直接追加")).result).toBe("accepted");
    expect((await stub.message("dup-1", "直接追加")).result).toBe("duplicate");
    const third = await reports("owner", 3);
    expect(third.filter(row => row.message_id.endsWith(":dup-1"))).toHaveLength(1);
    expect((await stub.status())?.inbox).toEqual({ reported: 3 });
  });

  it("wakes with the spawner's rights: owner tools only when the owner sent the task", async () => {
    const { outputs, seen } = twoModels([
      spawn("成员的任务"), { text: "好" }, { tool: "schedule", args: { action: "create", name: "提醒", prompt: "提醒喝水", rule: { at: "2030-01-01 08:00" } } }, { text: "完" },
      spawn("主人的任务"), { text: "好" }, { tool: "schedule", args: { action: "create", name: "提醒", prompt: "提醒喝水", rule: { at: "2030-01-01 08:00" } } }, { text: "完" },
      spawn("私聊主人的任务"), { text: "好" }, { tool: "mem_remember", args: { text: "主人喜欢简洁的回复", kind: "preference" } },
    ], [{ text: "成员任务的结果" }, { text: "主人任务的结果" }, { text: "私聊任务的结果" }]);
    const group = "group:200000001";
    expect(await thread(group).submit(input(1, "派个子 agent", 10000003, 200000001, true))).toEqual({ status: "done" });
    await reports(group, 1);
    expect(outputs.parent[1]).toContain("定时管理授权");
    const groupSub = await onlySubagent(group);
    expect(seen.parent.find(request => request.user.includes("成员任务的结果"))?.identity).toContain("派出者是 群成员");

    expect(await thread(group).submit(input(2, "我也派一个", 10000001, 200000001, true))).toEqual({ status: "done" });
    await reports(group, 2);
    expect(outputs.parent[3]).toMatch(/^[0-9a-f-]{36} · 提醒 · 状态：启用/);

    expect(await thread("owner").submit(input(3, "私聊派一个", 10000001))).toEqual({ status: "done" });
    await reports("owner", 1);
    expect(outputs.parent[5]).toContain("只读权限");
  });

  it("cancels the child at the deadline from the parent alarm and wakes the parent with a timeout report", async () => {
    twoModels([spawn("慢任务", { timeoutMs: 1000 })], ["hang"]);
    const group = "group:200000001";
    expect(await thread(group).submit(input(1, "派个慢的", 10000003, 200000001, true))).toEqual({ status: "done" });
    const sub = await onlySubagent(group);
    await vi.waitFor(async () => {
      await runDurableObjectAlarm(thread(group));
      expect((await thread(group).subagentList())[0]?.status).toBe("timeout");
    }, { timeout: 10_000, interval: 300 });
    expect((await child(group, sub.id).status())?.meta.status).toBe("cancelled");
    const [report] = await reports(group, 1);
    expect(report!.text).toMatch(/^\[子 agent 超时\] id=/);
    expect(report!.user_id).toBe("10000003");
  });

  it("allows concurrent tasks without default deadlines and preserves explicit long deadlines", async () => {
    const { outputs } = twoModels([spawn("任务 1"), spawn("任务 2"), spawn("任务 3"), spawn("长任务", { timeoutMs: 7 * 3600_000 })], ["hang", "hang", "hang", "hang"]);
    expect(await thread("owner").submit(input(1, "派四个", 10000001))).toEqual({ status: "done" });
    expect(outputs.parent).toHaveLength(4);
    expect(outputs.parent.every(output => output.startsWith("已派出子 agent"))).toBe(true);
    const list = await thread("owner").subagentList();
    expect(list.filter(sub => sub.deadline === null)).toHaveLength(3);
    const limited = list.find(sub => sub.task === "长任务")!;
    expect(limited.deadline! - limited.createdAt).toBe(7 * 3600_000);
    await runDurableObjectAlarm(thread("owner"));
    expect((await thread("owner").stats()).subagents).toEqual({ running: 4 });
    for (const sub of list) await thread("owner").cancelSubagent(sub.id);
  });

  it("continues beyond 24 model calls and ten minutes of task age", async () => {
    const ready = gate();
    const { seen } = twoModels([spawn("持续整理上下文"), { text: "已派出" }], [
      ...Array.from({ length: 25 }, (_, i): Step => ({ tool: "qq_context", args: {}, ...(i === 0 ? { after: ready.promise } : {}) })),
      { text: "整理完成" },
    ]);
    await thread("owner").submit(input(1, "持续整理", 10000001));
    const sub = await onlySubagent("owner");
    await expect.poll(() => seen.child.length).toBe(1);
    const now = Date.now.bind(Date);
    vi.spyOn(Date, "now").mockImplementation(() => now() + 20 * 60_000);
    ready.open();
    await expect.poll(async () => (await rows("owner", "SELECT 1 FROM inbound WHERE kind='subagent'")).length, { timeout: 10_000 }).toBe(1);
    // 本测试只改了 Date.now，workerd 的真实闹钟时钟没有前进；显式交付已排定的回报唤醒。
    await runDurableObjectAlarm(thread("owner"));
    expect((await reports("owner", 1))[0].text).toContain("整理完成");
    expect(seen.child).toHaveLength(26);
    expect((await onlySubagent("owner")).deadline).toBeNull();
  });

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
    expect((await env.REGISTRY.getByName("main").skillGet("example"))?.files).toEqual({"sources.md":"中文来源说明"});

  });

  it("撤销原任务后父会话续轮不能发布技能",async()=>{
    await seedPublishSkill();
    const ready=gate(),resume=gate();
    vi.spyOn(RegistryDO.prototype,"mcpConfig").mockReturnValue({...MCP_CONFIG,enabled:false,servers:[]});
    const {outputs,seen}=twoModels([spawn("检查技能"),{text:"已派出"},
      {tool:"codemode",after:resume.promise,args:{code:'text(await tools.skill_publish({path:"skills/example",workspaceRevision:"x",expectedRevision:"absent"}));'}},
      {text:"授权已撤销"}], [{text:"请主会话发布",after:ready.promise}]);
    await thread("owner").submit(input(1,"检查并发布技能",10000001));
    ready.open();
    await vi.waitFor(()=>expect(seen.parent.some(r=>r.user.startsWith("[子 agent 完成]"))).toBe(true));
    await rows("owner","UPDATE sandbox_tasks SET revoked_at=1");
    resume.open();
    await reports("owner",1);
    expect(outputs.parent[1]).toContain("denied");
    expect(await env.REGISTRY.getByName("main").skillGet("example")).toBeUndefined();
  });

  it.each(["capability", "identity", "generation", "cancelled", "channel", "task"] as const)("rechecks %s before a parent report turn uses the sandbox", async change => {
    const childReady = gate(), resume = gate();
    vi.spyOn(RegistryDO.prototype, "mcpConfig").mockReturnValue({ ...MCP_CONFIG, enabled: false, servers: [] });
    const { outputs, seen } = twoModels([spawn("检查工作区"), { text: "已派出" },
      { tool: "codemode", after: resume.promise, args: { code: 'text(await tools.sandbox_list({}));' } }, { text: "权限已失效" },
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

  it("lists, inspects and cancels subagents through the authenticated admin API", async () => {
    twoModels([spawn("面板任务")], ["hang"]);
    expect(await thread("owner").submit(input(1, "派一个", 10000001))).toEqual({ status: "done" });
    const sub = await onlySubagent("owner");
    expect((await admin("GET", "/admin/threads/owner/subagents", null)).status).toBe(401);
    expect((await admin("POST", `/admin/subagents/${sub.id}/cancel?thread=owner`, "wrong")).status).toBe(401);
    const list = await (await admin("GET", "/admin/threads/owner/subagents")).json<SubagentView[]>();
    expect(list).toEqual([expect.objectContaining({ id: sub.id, task: "面板任务", status: "running" })]);

    await vi.waitFor(async () => {
      const transcript = await (await admin("GET", `/admin/subagents/${sub.id}/transcript?thread=owner&limit=5`)).json<{ entries: { text: string }[] }>();
      expect(transcript.entries.some(entry => entry.text.includes("面板任务"))).toBe(true);
    });
    expect((await admin("POST", `/admin/subagents/${sub.id}/cancel`)).status).toBe(400);
    expect((await admin("POST", `/admin/subagents/${"0".repeat(8)}-0000-0000-0000-${"0".repeat(12)}/cancel?thread=owner`)).status).toBe(404);
    expect(await (await admin("POST", `/admin/subagents/${sub.id}/cancel?thread=owner`)).json()).toEqual({ id: sub.id, status: "cancelled" });
    expect((await child("owner", sub.id).status())?.meta.status).toBe("cancelled");
    expect(await rows("owner", "SELECT 1 FROM inbound WHERE kind = 'subagent'")).toEqual([]);
  });
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
  const list = await thread("owner").subagentList();
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
  await rows("owner", "UPDATE subagents SET origin_json=json_set(origin_json, '$.capabilities.sandboxId', ?) WHERE id=?", oldId, sub.id);
  const run = vi.spyOn(SandboxDO.prototype, "run");
  expect(await thread("owner").validateSubagentAccess(sub.id)).toMatchObject({ capabilities: { sandboxId: oldId, coding: false } });
  const result = await runInDurableObject(thread("owner"), async instance => {
    if (!(instance instanceof ThreadDO)) throw new Error("wrong fixture");
    return (await instance.subagentCoding(sub.id, { kind: "read", operationId: "test", path: "file" })).isError;
  });
  expect(result).toBe(true);
  expect(run).not.toHaveBeenCalled();
  await expect((async () => await thread("owner").workspaceInspectChild("owner", { childId: sub.id }))()).rejects.toThrow("workspace_denied");
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
