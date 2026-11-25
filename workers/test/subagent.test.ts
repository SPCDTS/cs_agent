import { env, reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { Errors } from "typebox/value";
import type { RequestsDO } from "../src/requests/do";
import * as C from "../browser/contracts";
type HistoryPage = Awaited<ReturnType<RequestsDO["subagentConversation"]>>;
import { ThreadDO } from "../src/thread";
import type { SubagentView } from "../src/subagent/parent";
import { responseDescription, shortSummary } from "../src/subagent/activity";
import { action, connect, input, reply, syncedView } from "./helpers";
import { admin, child, gate, idOf, onlySubagent, reports, rows, spawn, thread, twoModels, type Step } from "./subagent-fixture";

const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  await reset();
  vi.restoreAllMocks();
});

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
    expect(tools).toEqual(expect.arrayContaining(["web_page", "qq_context", "mem_search"]));
    for (const name of ["send_message", "subagent", "generate_image", "mem_remember", "schedule", "gmail_send", "skill_inspect", "skill_publish"]) expect(tools).not.toContain(name);
    expect(seen.parent[0]!.tools).toContain("subagent");

    await vi.waitFor(async () => expect((await child("owner", sub.id).status())?.meta).toMatchObject({ status: "done", reportCount: 1 }));
    expect(sub).toMatchObject({ status: "done", spawner: "owner 10000001" });
    const audit = await rows<{ kind: string; detail: string }>("owner", "SELECT kind, detail FROM events WHERE kind LIKE 'subagent_%' ORDER BY kind");
    expect(audit.map(event => event.kind)).toEqual(["subagent_report", "subagent_spawn"]);
    expect(JSON.stringify(audit)).not.toMatch(/A 与 B|调研结果/);
  });

  it("agent_send uses the child inbox while busy and child replies use the same communication path", async () => {
    const first = gate();
    const { seen, outputs } = twoModels(
      [spawn("先处理第一项"), { text: "已派出" },
        out => ({tool:"agent_send",args:{to:"sub:owner:" + idOf(out[0]),text:"第二项"}}), {text:"已入箱"},
        {text:"收到第一项"}, {text:"收到子会话通信"}, {text:"收到第二项"}],
      [{text:"第一项完成",after:first.promise},
        {tool:"agent_send",args:{to:"owner",text:"子会话主动回复"}}, {text:"第二项完成"}]);
    await thread("owner").submit(input(1,"开始",10000001));
    const sub = await onlySubagent("owner");
    await vi.waitFor(async () => expect((await child("owner",sub.id).status())?.inbox.running).toBe(1));
    await thread("owner").submit(input(2,"给子会话追加",10000001));
    expect((await child("owner",sub.id).status())?.inbox).toMatchObject({running:1,queued:1});
    expect(outputs.parent.some(value=>value.includes('"status":"accepted"'))).toBe(true);
    first.open();
    await reports("owner",2);
    await vi.waitFor(async () => expect(await rows("owner","SELECT 1 FROM inbound WHERE kind='agent' AND status='done'")).toHaveLength(1));
    const peer = await rows<{user_id:string;agent_from:string}>("owner","SELECT user_id,agent_from FROM inbound WHERE kind='agent'");
    expect(peer[0]).toMatchObject({user_id:"",agent_from:"sub:owner:"+sub.id});
    expect(seen.child[0]?.tools).toContain("agent_send");
    expect(await rows("owner","SELECT 1 FROM outgoing_intents")).toHaveLength(0);
  });

  it("blocks credentials in automatic results without losing the completion notification", async () => {
    twoModels([spawn("检查"), {text:"已派出"}, {text:"已收到拒传提示"}],
      [{text:"Authorization: Bearer synthetic-credential-for-test-only"}]);
    await thread("owner").submit(input(1,"检查",10000001));
    const [report] = await reports("owner",1);
    expect(report?.text).toContain("已隐藏");
    expect(report?.text).toContain("[子 agent 完成]");
    expect(report?.text).not.toContain("synthetic-credential-for-test-only");
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
    await onlySubagent(group);
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
      expect((await (await syncedView(group)).subagentList())[0]?.status).toBe("timeout");
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
    const list = await (await syncedView("owner")).subagentList();
    expect(list.filter(sub => sub.deadline === null)).toHaveLength(3);
    const limited = list.find(sub => sub.task === "长任务")!;
    expect(limited.deadline! - limited.createdAt).toBe(7 * 3600_000);
    await runDurableObjectAlarm(thread("owner"));
    expect((await (await syncedView("owner")).stats()).subagents).toEqual({ running: 4 });
    for (const sub of list) await thread("owner").cancelSubagent(sub.id);
  });

  it("continues beyond 24 model calls and ten minutes of task age", async () => {
    const ready = gate();
    const { seen } = twoModels([spawn("持续整理上下文"), { text: "已派出" }], [
      ...Array.from({ length: 25 }, (_, i): Step => ({ tool: "qq_context", args: {}, ...(i === 0 ? { after: ready.promise } : {}) })),
      { text: "整理完成" },
    ]);
    await thread("owner").submit(input(1, "持续整理", 10000001));
    await onlySubagent("owner");
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

  it("lists, inspects and cancels subagents through the authenticated admin API", async () => {
    twoModels([spawn("面板任务")], ["hang"]);
    expect(await thread("owner").submit(input(1, "派一个", 10000001))).toEqual({ status: "done" });
    const sub = await onlySubagent("owner");
    expect((await admin("GET", "/admin/threads/owner/subagents", null)).status).toBe(401);
    expect((await admin("POST", `/admin/subagents/${sub.id}/cancel?thread=owner`, "wrong")).status).toBe(401);
    // 展示副本主动异步同步，任务创建成功不代表展示批次已送达。
    await vi.waitFor(async () => {
      const response = await admin("GET", "/admin/threads/owner/subagents");
      expect(response.status).toBe(200);
      expect(await response.json<SubagentView[]>()).toEqual([expect.objectContaining({ id: sub.id, task: "面板任务", status: "running" })]);
    });

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

  it("管理台可分页查看子会话正文与工具记录，且读取不唤醒执行 DO", async () => {
    const task = "需要逐项核对的任务。".repeat(35) + "任务末尾", answer = "这是核对后的结果。".repeat(35) + "结果末尾";
    const ready = gate();
    const { seen } = twoModels([spawn(task)], [...Array.from({ length: 6 }, (): Step => ({ tool: "qq_context", args: {} })), { text: answer, after: ready.promise }]);
    await thread("owner").submit(input(1, "查看子会话", 10000001));
    const sub = await onlySubagent("owner");
    await vi.waitFor(() => expect(seen.child).toHaveLength(7));
    await thread("owner").syncAdminView("owner");
    await child("owner", sub.id).syncAdminView();
    const running = await admin("GET", "/admin/subagents/" + sub.id + "/history?thread=owner");
    expect(running.status).toBe(200);
    const active = await running.json<HistoryPage>();
    expect([...Errors(C.SubagentConversationSchema, active)]).toEqual([]);
    expect(active.status).toBe("running");
    expect(active.syncedAt).toBeGreaterThan(0);
    ready.open();
    await reports("owner", 1);
    await thread("owner").syncAdminView("owner");
    await child("owner", sub.id).syncAdminView();
    await thread("group:200000001").syncAdminView("group:200000001");
    const execution = vi.spyOn(ThreadDO.prototype, "syncAdminView").mockRejectedValue(new Error("execution_read_forbidden"));
    const path = "/admin/subagents/" + sub.id + "/history?thread=owner";
    expect((await admin("GET", path, null)).status).toBe(401);
    expect((await admin("GET", path + "&cursor=!!!")).status).toBe(400);
    expect((await admin("GET", "/admin/subagents/" + sub.id + "/history")).status).toBe(400);
    expect((await admin("GET", path.replace("thread=owner", "thread=group:200000001"))).status).toBe(404);
    const entries: HistoryPage["entries"] = [];
    let cursor: string | undefined;
    do {
      const response = await admin("GET", path + (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""));
      expect(response.status).toBe(200);
      const page = await response.json<HistoryPage>();
      expect([...Errors(C.SubagentConversationSchema, page)]).toEqual([]);
      expect(page.status).toBe("done");
      expect(page.summary).toBeTruthy();
      if (!cursor) { expect(page.entries).toHaveLength(10); expect(page.next).toBeTruthy(); }
      entries.push(...page.entries); cursor = page.next;
    } while (cursor);
    expect(new Set(entries.map(entry => entry.id)).size).toBe(entries.length);
    const messages = entries.flatMap(entry => entry.messages);
    expect(messages.some(message => message.role === "user" && message.text.includes(task))).toBe(true);
    expect(messages.some(message => message.role === "assistant" && message.text.includes(answer))).toBe(true);
    expect(messages.some(message => message.toolName === "qq_context")).toBe(true);
    const calls = messages.flatMap(message => message.toolCalls ?? []);
    expect(calls).toHaveLength(6);
    expect(calls.every(call => call.name === "qq_context" && JSON.parse(call.arguments))).toBe(true);
    expect(messages.filter(message => message.toolCalls?.length).every(message => !message.text.includes("qq_context"))).toBe(true);
    expect(execution).not.toHaveBeenCalled();
    execution.mockRestore();
    await rows("owner", "UPDATE subagents SET ended_at=? WHERE id=?", Date.now() - 15 * 86400_000, sub.id);
    await thread("owner").syncAdminView("owner");
    expect((await admin("GET", path)).status).toBe(404);
  });
});
