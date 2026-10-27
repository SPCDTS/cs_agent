import type { TranscriptContext } from "@earendil-works/pi-ai";
import type { ConversationId } from "@earendil-works/pi-durable";
import { afterEach, expect, it, vi } from "vitest";
import { trace, type LiveEvent } from "../../../src/shared/trace.js";
import { logBuffer } from "../../../src/shared/log.js";
import { parseMcpConfig } from "../../../src/agent/pi-mcp/config.js";
import { runRights } from "../../../src/agent/host/identity.js";
import { BASE_ONLY_SEND } from "../../../src/agent/grants.js";
import { EventService, eventInputKey } from "../../../src/agent/events/service.js";
import { EventsDoc } from "../../../src/agent/events/docs.js";
import { renderEventInput } from "../../../src/agent/events/render.js";
import { httpFixture } from "../fixtures/pi-mcp-http.js";
import { context, gate, lastUser, reply, residentRig, type ResidentRig } from "../resident-fixture.js";
import { mail, START } from "./fixture.js";

function offeredTools(transcript: TranscriptContext) {
  const names = new Set<string>();
  for (const message of transcript.messages) if (message.role === "system") {
    for (const tool of message.toolsRemoved ?? []) names.delete(tool.name);
    for (const tool of message.toolsAdded ?? []) names.add(tool.name);
  }
  return [...names];
}
async function event(r: ResidentRig, id: string, deliver = true) {
  const key = eventInputKey("gmail", id);
  r.bridge.inbox.openEventInput({ key, owner: "1", source: "gmail", count: 1, eventKeys: [key],
    time: START / 1000, text: renderEventInput("gmail", [mail(id)], 0, START) });
  if (deliver) await r.inbox.deliverEvent(key);
  return key;
}
const servers: Awaited<ReturnType<typeof httpFixture>>[] = [];
afterEach(async () => { for (const server of servers.splice(0)) await server.close(); });

it("事件在 owner 线程开轮，只见只读工具，发送目标和授权由宿主拒绝", async () => {
  const hold = gate(), seen: string[][] = [], inputs: string[] = [], events: LiveEvent[] = [];
  const stop = trace.tap(event => events.push(event));
  try {
    const r = await residentRig({ brain: async (transcript, signal) => {
      seen.push(offeredTools(transcript)); inputs.push(lastUser(transcript)); await hold.wait(signal); return reply("私密摘要");
    } });
    const key = await event(r, "one");
    await vi.waitFor(() => expect(hold.entered).toBe(1));
    const binding = r.inbox.binding("owner");
    expect(binding).toMatchObject({ threadKey: "owner", scope: "private:1", identity: { kind: "event", source: "gmail", creator: "1" } });
    expect(runRights(binding, r.owners)).toMatchObject({ access: "all", auth: false, person: { kind: "event", owner: true } });
    expect(inputs[0]).toContain("[外部事件]");
    expect(seen[0]).toContain("read"); expect(seen[0]).toContain("send_message");
    expect(seen[0].filter(name => /^(auth_|schedule_)/.test(name) || ["write", "edit", "bash", "subagent", "skill_publish"].includes(name))).toEqual([]);
    const sendBinding = { ...binding, access: { kind: "all" as const }, workdir: r.dir };
    await expect(r.sendService.send(sendBinding, { text: "拒绝", target: "qq:private:1" }, "explicit-target")).rejects.toThrow(BASE_ONLY_SEND);
    expect(await r.grants.permissions(binding)).toMatchObject({ auth: false, target: false });
    await expect(r.grants.tool(binding, "auth_list", {})).rejects.toThrow();
    await r.sendService.send(sendBinding, { text: "私密发送资料" }, "session-send");
    expect(r.bridge.outbox.listOutboxByTurn(binding.turnId!)[0]).toMatchObject({ proactive: true, mention_user_id: null, target_id: "1" });
    hold.open(); await r.idle();
    expect(r.bridge.inbox.getInbound(key)?.state).toBe("done");
    expect(JSON.stringify(events)).not.toMatch(/私密/);
  } finally { stop(); }
});

it("用户与事件相互排队不插话，queued 事件重启后保留外壳", async () => {
  const userGate = gate(), eventGate = gate(), inputs: string[] = [];
  const r = await residentRig({ brain: async (transcript, signal) => {
    const text = lastUser(transcript); inputs.push(text);
    if (text.includes("先处理")) await userGate.wait(signal);
    else if (text.startsWith("[外部事件]")) await eventGate.wait(signal);
    return reply();
  } });
  await r.say("1", "先处理", null); await vi.waitFor(() => expect(userGate.entered).toBe(1));
  const key = await event(r, "queued");
  expect(r.bridge.inbox.getInbound(key)?.state).toBe("queued"); expect(inputs).toHaveLength(1);
  userGate.open(); await vi.waitFor(() => expect(eventGate.entered).toBe(1));
  const later = await r.say("1", "后续处理", null);
  expect(r.bridge.inbox.getInbound(later)?.state).toBe("queued");
  eventGate.open(); await r.idle(); expect(inputs).toHaveLength(3);
  const recovered = await event(r, "recovered", false); await r.restart(); await r.idle();
  expect(r.bridge.inbox.getInbound(recovered)?.state).toBe("done");
  expect(inputs.at(-1)).toContain("[外部事件]");
});

it("事件 MCP 目录仅选 eventAllow；空列表服务不连接，用户回合恢复完整工具", async () => {
  const included = await httpFixture(), excluded = await httpFixture(); servers.push(included, excluded);
  const config = parseMcpConfig({ version: 1, enabled: true, servers: [
    { ...included.config, tools: { allow: ["first", "second"], eventAllow: ["first"] }, resources: { allow: ["notion://docs/"] } },
    { ...excluded.config, id: "excluded" },
  ] });
  if (config.kind !== "enabled") throw new Error("config");
  const seen: string[][] = [];
  const r = await residentRig({ mcp: { config, secrets: { readReferencedVariable: () => "host-fixture-secret" } },
    brain: transcript => { seen.push(offeredTools(transcript)); return reply(); } });
  await event(r, "mcp"); await r.idle();
  // 业务工具只给 codemode 脚本调用，按当前 conversation 的可调用目录检查，不能只看模型首次请求。
  const id = (await r.pi.readThreadIds()).owner;
  const conv = await r.pi.harness.conversation(id! as ConversationId, context);
  const agent = await conv!.agent(context);
  expect(agent.callable.filter(t => t.name.startsWith("mcp_fixture_")).map(t => t.name)).toEqual([expect.stringMatching(/^mcp_fixture_first_/)]);
  expect(seen[0]).toContain("mcp_read_resource");
  expect(excluded.messages).toEqual([]);
  await r.say("1", "现在由主人处理", null); await r.idle();
  expect(seen.at(-1)).toEqual(expect.arrayContaining(["write", "bash", "subagent"]));
  expect(excluded.messages.length).toBeGreaterThan(0);
});

it("eventAllow 必须是 allow 子集，默认禁止事件 MCP", () => {
  const server = { id: "gmail", transport: { kind: "stdio", command: "node", args: [] }, credential: { kind: "none" }, tools: { allow: ["read"], eventAllow: ["write"] } };
  const invalid = parseMcpConfig({ version: 1, enabled: true, servers: [server] });
  expect(invalid).toMatchObject({ kind: "invalid", issues: expect.arrayContaining([expect.objectContaining({ message: "eventAllow 必须是 allow 的子集" })]) });
});

it("读取真实会话后端：Codex 积压，切为 Pi 后下一次轮询投递；宿主拒绝切换竞态", async () => {
  let backend: "pi" | "codex" = "codex";
  const r = await residentRig({ backend: () => backend });
  await r.say("1", "初始化 owner 会话", null); await r.idle();
  expect(await r.host.recordedBackend("owner")).toBe("codex");
  const poll = vi.fn(async () => ({ cursor: "10", events: [mail("backend")] }));
  const insert = vi.fn(r.bridge.inbox.openEventInput.bind(r.bridge.inbox));
  const service = new EventService({ harness: r.harness, owner: "1", sources: [{ id: "gmail", poll }],
    ownerBackend: () => r.host.recordedBackend("owner"), inputOutcome: key => r.host.inputOutcome(key),
    inbox: { get: key => r.bridge.inbox.getInbound(key), insert, deliver: key => r.inbox.deliverEvent(key) } });
  try {
    await service.start();
    await r.harness.commit(async tx => { (await tx.doc(EventsDoc)).sources.gmail.settings.mergeWindowS = 0; }, context);
    await service.pollNow("gmail"); expect(insert).not.toHaveBeenCalled();
    expect((await service.list())[0]).toMatchObject({ held: [mail("backend")], stats: {
      degraded: true, blockedReason: "owner 线程后端为 codex，事件需要 Pi 后端",
    } });
    backend = "pi";
    await r.say("1", "切换 owner 会话", null); await r.idle();
    await service.pollNow("gmail"); await r.idle(); expect(insert).toHaveBeenCalledTimes(1);
    expect((await service.list())[0].held).toEqual([]);
    expect((await service.list())[0].stats.blockedReason).toBeUndefined();
    expect((await service.list())[0].stats.degraded).toBe(false);
    // 服务检查后配置变动，ThreadHost.plan 在开轮前选为 Codex，仍须失败且不触发模型。
    backend = "codex";
    const before = r.script.turns.length;
    const race = await event(r, "race"); await r.idle();
    expect(r.script.turns).toHaveLength(before);
    expect(r.bridge.inbox.getInbound(race)?.state).toBe("done");
    expect(await r.host.inputOutcome(race)).toEqual({ status: "failed", reason: "backend_unsupported" });
  } finally { await service.stop(); }
});

it("重启补传的事件附件失败也不把标题、文件名或正文写入日志与 trace", async () => {
  const r = await residentRig(), key = await event(r, "attachment", false);
  const row = r.bridge.outbox.reserveOutbox({ key: "owner:recovered-event-send", thread_key: "owner", turn_id: "pi:recovered-event", input_key: key,
    message_type: "private", target_id: "1", mention_user_id: null, proactive: true, text: "EVENT_PRIVATE_BODY", images: [],
    files: [{ filename: r.dir + "/EVENT_PRIVATE_TITLE.txt", name: "EVENT_PRIVATE_TITLE.txt", bytes: 1, sha256: "missing", status: "pending" }] });
  r.bridge.outbox.markOutboxSending(row.key); r.bridge.outbox.markOutboxSent(row.key, "already-sent");
  const events: LiveEvent[] = [], logs: unknown[] = [];
  const offTrace = trace.tap(e => events.push(e)), offLog = logBuffer.subscribe(e => logs.push(e));
  try {
    await r.sendService.reconcile();
    expect(r.bridge.outbox.getOutbox(row.key)?.files[0].status).toBe("uncertain");
    expect(JSON.stringify({ events, logs })).not.toContain("EVENT_PRIVATE");
  } finally { offTrace(); offLog(); }
});
