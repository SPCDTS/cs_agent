import { promises as fs } from "node:fs";
import path from "node:path";
import { estimateContextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { getSystemMessageText, type Message, type TranscriptContext } from "@earendil-works/pi-ai";
import { CompactionEntry, defineDoc, type ConversationId } from "@earendil-works/pi-durable";
import { describe, expect, it, vi } from "vitest";
import { PiThreadsArchiveDoc } from "../../src/agent/backends/pi.js";
import { DeepSeekWeb, publicPageUrl } from "../../src/agent/pi-tools/web.js";
import { DEFAULT_PI_PROMPT, PiPromptLoader } from "../../src/agent/pi-tools/prompt.js";
import { PI_SUBAGENT_RULE, PI_WORKSPACE_RULE } from "../../src/agent/pi-tools/index.js";
import { PiContextObserver, piContextCapacity, refreshPiCompactionUsage } from "../../src/agent/pi-context-usage.js";
import { SCHEDULE_MANAGEMENT_TOOLS } from "../../src/shared/schedule-tools.js";
import { threadKeyOf } from "../../src/channel/ticket.js";
import type { Channel, InboundMessage } from "../../src/channel/types.js";
import { inboundKey, type ReplyStore } from "../../src/qq/reply-store.js";
import { TRANSPARENT_PNG, UnknownJobError } from "../../src/media/gen/image-gen.js";
import { MemoryInstrumentation } from "../../src/obs/memory/instrumentation.js";
import { ObsStore } from "../../src/obs/store.js";
import { log } from "../../src/shared/log.js";
import { trace, type LiveEvent } from "../../src/shared/trace.js";
import { mediaFixture } from "../context/media-fixture.js";
import { tmp } from "./helpers.js";
import { put } from "./pi-sandbox-fixture.js";
import { scheduleToolsFixture } from "./schedule-tools-fixture.js";
import { call, context, reply, residentRig, type Brain, type ResidentOptions, type ResidentRig } from "./resident-fixture.js";

type Step = Message | ((ctx: TranscriptContext, extra?: { model: string; reasoning: unknown }) => Message | Promise<Message>);

/** 按顺序消费的模型脚本；用完后一律简短回答。 */
function script(...steps: Step[]): Brain & { push(...more: Step[]): void; left(): number } {
  const queue = [...steps];
  const brain = ((ctx: TranscriptContext, _signal: AbortSignal | undefined, extra?: { model: string; reasoning: unknown }) => {
    const step = queue.shift();
    if (!step) return reply();
    return typeof step === "function" ? step(ctx, extra) : step;
  }) as Brain & { push(...more: Step[]): void; left(): number };
  brain.push = (...more) => { queue.push(...more); };
  brain.left = () => queue.length;
  return brain;
}

async function rig(steps: Step[], options: ResidentOptions = {}): Promise<ResidentRig & { script: ReturnType<typeof script> }> {
  const brain = script(...steps);
  const r = await residentRig({ ...options, brain });
  return Object.assign(r, { script: brain });
}

const toolResults = (ctx: TranscriptContext) => ctx.messages.filter(m => m.role === "toolResult");
const results = (ctx: TranscriptContext) => toolResults(ctx).map(m => JSON.stringify(m.content)).join("\n");
const systemOf = (ctx: TranscriptContext) => {
  const system = ctx.messages.findLast(m => m.role === "system");
  if (!system || system.role !== "system") throw new Error("缺少 system 消息");
  return getSystemMessageText(system);
};
const turnOf = (r: ResidentRig, key: string) => r.bridge.inbox.getInbound(key)!.turn_id!;
const convOf = async (r: ResidentRig, key: string) => (await r.pi.harness.conversation((await r.pi.readThreadIds())[key]! as ConversationId, context))!;
/** say + idle：一条消息完整处理完。 */
const turn = async (r: ResidentRig, user: string, text: string, group: string | null = "7", extra: Partial<InboundMessage> = {}) => {
  const key = await r.say(user, text, group, extra);
  await r.idle();
  return key;
};

/** 先算出入站键再放附件（附件目录 incoming/<入站键>），之后照常落盘投递。 */
async function sayWithImages(r: ResidentRig, user: string, text: string, files: (dir: string) => Promise<string[]>, group: string | null = "7") {
  const msg = r.message(user, text, group);
  const key = inboundKey(msg);
  msg.images = await files(path.join(r.dir, "incoming", key));
  (r.bridge.inbox as ReplyStore).admit(msg, threadKeyOf(msg, r.owners));
  r.history.ingest(msg);
  await r.inbox.receive(msg, key);
  await r.idle();
  return key;
}

describe("pi 常驻后端：工具身份随本轮绑定", () => {
  it.each([false, true])("qq_chats 仅在 all 范围调用通道（owner=%s）", async owner => {
    const listChats = vi.fn<Channel["listChats"]>().mockResolvedValue({ groups: [{ group_id: "7", name: "家庭群", member_count: 6 }], friends: [] });
    let seen!: TranscriptContext;
    const r = await rig([call(["qq_chats", {}]), ctx => { seen = ctx; return reply(); }], { channel: { listChats } });
    await turn(r, owner ? "1" : "5", "列一下会话", owner ? null : "7");
    expect(listChats).toHaveBeenCalledTimes(owner ? 1 : 0);
    expect(results(seen)).toContain(owner ? "group:7 家庭群（6 人）" : "仅限主人回合");
    expect(toolResults(seen).find(m => m.toolName === "qq_chats")?.isError).toBe(!owner);
  });

  it.each([true, false])("技能写权限与提示按本轮发送者接线（owner 私聊=%s），下一条非 owner 消息不可改", async privateOwner => {
    const dir = tmp("pi-skills-owner-"), skillsDir = path.join(dir, "custom-skills"), file = path.join(skillsDir, "hello", "SKILL.md");
    const text = "---\nname: hello\ndescription: owner 新增技能\n---\n正文";
    const seen: TranscriptContext[] = [];
    const inspect = (ctx: TranscriptContext) => { seen.push(ctx); return reply(); };
    const r = await rig([call(["write", { path: file, content: text }]), inspect, call(["write", { path: file, content: "群改写" }]), inspect], { skillsDir });
    await turn(r, "1", "写个技能", privateOwner ? null : "7");
    expect(await fs.readFile(file, "utf8")).toBe(text);
    expect(systemOf(seen[0]!)).toContain("技能写入规则");
    expect(systemOf(seen[0]!)).toContain(skillsDir + "/<name>/");
    await turn(r, "5", "改技能");
    expect(systemOf(seen[1]!)).toContain("owner 新增技能");
    expect(systemOf(seen[1]!)).not.toContain("技能写入规则");
    expect(toolResults(seen[1]!).some(m => m.isError)).toBe(true);
    expect(await fs.readFile(file, "utf8")).toBe(text);
    const ids = await r.pi.readThreadIds();
    expect(Object.keys(ids).sort()).toEqual(privateOwner ? ["group:7", "owner"] : ["group:7"]);
  });

  it.each(["group", "owner", "private"])("%s 会话注册四个内置工具并在独立工作目录执行", async kind => {
    let seen: TranscriptContext | undefined;
    const r = await rig([call(["write", { path: "note.txt", content: "原文" }]),
      call(["edit", { path: "note.txt", edits: [{ oldText: "原文", newText: "改后" }] }]),
      call(["read", { path: "note.txt" }]), call(["bash", { command: "printf builtin-ok" }]),
      ctx => { seen = ctx; return reply(); }]);
    await expect(fs.access(path.join(r.dir, "pi-work"))).rejects.toThrow();
    const [user, group, key] = kind === "group" ? ["5", "7", "group:7"] : kind === "owner" ? ["1", null, "owner"] : ["5", null, "private:5"];
    await turn(r, user!, "写文件", group);
    expect(await fs.readFile(path.join(r.dir, "pi-work", key!.replace(":", "_"), "note.txt"), "utf8")).toBe("改后");
    const tools = toolResults(seen!);
    expect(tools.map(m => m.toolName)).toEqual(["write", "edit", "read", "bash"]);
    expect(tools.slice(0, 3).every(m => !m.isError)).toBe(true);
    expect(tools[3]!.isError).toBe(process.platform !== "linux");
    expect(results(seen!)).toContain(process.platform === "linux" ? "builtin-ok" : "Linux bwrap");
    expect(DEFAULT_PI_PROMPT).toContain("用 read 打开");
  });

  it("配置的 Codex 工作区禁读，read 不能跨 scope 读取", async () => {
    const dir = tmp("cs-pi-workspace-");
    const workspaceDir = path.join(dir, "configured-workspace");
    const secret = await put(path.join(workspaceDir, "group_8", "note"), "other-scope-secret");
    let seen: TranscriptContext | undefined;
    const r = await rig([call(["read", { path: secret }]), ctx => { seen = ctx; return reply(); }], { workspaceDir });
    await turn(r, "5", "读一下");
    expect(toolResults(seen!)[0]?.isError).toBe(true);
    expect(results(seen!)).toContain("拒绝读取");
    expect(results(seen!)).not.toContain("other-scope-secret");
  });

  it("read 打开召回路径返回图片内容", async () => {
    let seen: TranscriptContext | undefined;
    const r = await rig([], { vision: true });
    const media = await mediaFixture(r.history, r.dir);
    r.script.push(call(["read", { path: media }]), ctx => { seen = ctx; return reply(); });
    await turn(r, "5", "看图");
    const result = toolResults(seen!).find(m => m.toolName === "read");
    expect(result?.content.some(c => c.type === "image" && c.mimeType === "image/png" && c.data.length > 0)).toBe(true);
    expect(result?.isError).toBe(false);
  });

  it("文件权限每次调用从宿主当前回合重建：换输入、跨 scope 与重启不沿用旧权限", async () => {
    const r = await rig([], { vision: true });
    const media = await mediaFixture(r.history, r.dir, "group:7");
    const groupImage = path.join(r.dir, "images", "group_7", "file.txt");
    let first: TranscriptContext | undefined, ref = "";
    r.script.push(ctx => call(["read", { path: ref }]), call(["write", { path: groupImage, content: "group-image" }]),
      call(["read", { path: media }]), ctx => { first = ctx; return reply("first"); });
    const old = await sayWithImages(r, "5", "看附件", async dir => {
      ref = path.join(dir, "ref.png"); await fs.mkdir(dir, { recursive: true }); await fs.writeFile(ref, TRANSPARENT_PNG); return [ref];
    });
    expect(toolResults(first!).map(m => !!m.isError)).toEqual([false, false, false]);
    expect(old).toBeTruthy();
    await r.restart();
    let second: TranscriptContext | undefined;
    const otherImage = path.join(r.dir, "images", "group_8", "x.txt");
    r.script.push(call(["read", { path: ref }]), call(["write", { path: otherImage, content: "bad" }]),
      call(["write", { path: path.join(r.dir, "images", "group_7", "new.txt"), content: "new-image" }]), ctx => { second = ctx; return reply(); });
    await turn(r, "5", "新的一轮");
    expect(toolResults(second!).slice(-3).map(m => !!m.isError)).toEqual([true, true, false]);
    expect(await fs.readFile(groupImage, "utf8")).toBe("group-image");
    let other: TranscriptContext | undefined;
    r.script.push(call(["read", { path: media }]), ctx => { other = ctx; return reply(); });
    await turn(r, "5", "别的群", "8");
    expect(toolResults(other!)[0]?.isError).toBe(true);
  });

  it("内置调用只记录工具、前二百字的命令或路径、退出码和耗时，按回合键归属", async () => {
    const events: LiveEvent[] = [];
    const untap = trace.tap(e => { if (e.ticket.startsWith("turn:pi:") && e.stage.startsWith("tool:")) events.push(e); });
    const r = await rig([call(["write", { path: "trace.txt", content: "do-not-log-file-content" }]),
      call(["read", { path: "trace.txt" }]), call(["bash", { command: "printf do-not-log-stdout; #" + "x".repeat(300) }]),
      call(["bash", { command: "exit 7" }]), reply()]);
    try {
      const key = await turn(r, "5", "记录");
      const done = events.filter(e => e.status !== "started");
      expect(done).toHaveLength(4);
      expect(new Set(done.map(e => e.ticket))).toEqual(new Set(["turn:" + turnOf(r, key)]));
      expect(done.every(e => typeof e.duration_ms === "number" && !("output" in e.detail) && !("input" in e.detail))).toBe(true);
      expect(done[0]!.detail).toMatchObject({ tool: "write", path: "trace.txt", exit_code: null });
      expect(String(done[2]!.detail.command)).toHaveLength(200);
      expect(done[3]!).toMatchObject({ status: "failed", detail: { tool: "bash", exit_code: process.platform === "linux" ? 7 : null } });
      expect(JSON.stringify(events)).not.toContain("do-not-log-file-content");
    } finally { untap(); }
  });

  it("qq_image 绑定本轮读取范围，不再按回合限次，结果仅有路径文本", async () => {
    let seen: TranscriptContext | undefined;
    const recall = vi.fn(async () => ({ text: "图1: /data/media/ab/test.png（1×1）", images: [{ path: "/data/media/ab/test.png", width: 1, height: 1 }] }));
    const r = await rig([...Array.from({ length: 6 }, () => call(["qq_image", { message_id: "123" }])), ctx => { seen = ctx; return reply(); }],
      { mediaRecall: { recall } });
    await turn(r, "5", "召回");
    expect(recall).toHaveBeenCalledTimes(6);
    expect(recall).toHaveBeenCalledWith({ kind: "scope", scope: "group:7" }, "123", expect.any(AbortSignal));
    expect(results(seen!)).toContain("/data/media/ab/test.png");
    expect(toolResults(seen!).every(m => m.content.every(c => c.type === "text"))).toBe(true);
    r.script.push(call(["qq_image", { message_id: "123" }]), reply());
    await turn(r, "1", "owner 召回");
    expect(recall).toHaveBeenLastCalledWith({ kind: "all" }, "123", expect.any(AbortSignal));
  });

  it("web_search 经 faux 模型调用；输入带来源头与引用", async () => {
    let seen: TranscriptContext | undefined;
    const http = vi.fn(async () => Response.json({ results: [{ title: "资料", date: "2026-10-18", summary: "摘要", url: "https://example.com", rerank_score: 1 }] })) as typeof fetch;
    const web = new DeepSeekWeb({ apiKey: "test-only", fetch: http, backoffMs: 1, resolve: async () => [{ address: "93.184.216.34", family: 4 }] });
    const r = await rig([call(["web_search", { query: "CS2", count: 3 }]), ctx => { seen = ctx; return reply("查到了"); }], { web });
    r.history.ingest(r.message("6", "此前的问题", "7", { message_id: "123", nickname: "友人" }));
    await turn(r, "5", "查一下", "7", { segments: [{ type: "reply", data: { id: "123" } }] });
    expect(results(seen!)).toContain("资料 / 2026-10-18 / 摘要 / https://example.com");
    expect(JSON.stringify(seen!.messages)).toContain("[来源] 群 7");
    expect(JSON.stringify(seen!.messages)).toContain("[引用 #123] 友人: 此前的问题");
    expect(JSON.parse(String(vi.mocked(http).mock.calls[0]![1]!.body))).toEqual({ query: "CS2", count: 3, need_content: false });
  });

  it("历史读取范围随本轮：群只读本群，owner 读全部", async () => {
    const seen: string[] = [];
    const final = (ctx: TranscriptContext) => { seen.push(results(ctx)); return reply(); };
    const r = await rig([call(["qq_recent", {}]), final, call(["qq_search", { query: "另群" }]), final,
      call(["qq_message", { message_id: "private-x" }]), final, call(["qq_recent", {}]), final]);
    r.history.ingest(r.message("6", "私人秘密", null, { message_id: "private-x" }));
    r.history.ingest(r.message("6", "本群消息", "7"));
    r.history.ingest(r.message("6", "另群记录", "8"));
    await turn(r, "5", "看看");
    expect(seen[0]).toContain("本群消息"); expect(seen[0]).not.toContain("私人秘密"); expect(seen[0]).not.toContain("另群记录");
    await turn(r, "5", "看看", "8");
    expect(seen[1]).toContain("另群记录");
    await turn(r, "5", "看看私聊");
    expect(seen[2]).toContain("没有这条消息"); expect(seen[2]).not.toContain("私人秘密");
    await turn(r, "1", "owner 看看", null);
    expect(seen[3]).toContain("私人秘密");
  });

  it("参考图按本轮读取范围校验：允许本群与 owner，拒绝别群和未登记路径", async () => {
    let seen = "";
    const r = await rig([]);
    const media = await mediaFixture(r.history, r.dir, "group:7");
    const foreign = path.join(r.dir, "outside.png"); await fs.writeFile(foreign, TRANSPARENT_PNG);
    r.script.push(call(["generate_image", { prompt: "编辑", reference_images: [media] }]), reply(),
      call(["generate_image", { prompt: "编辑", reference_images: [media] }]), ctx => { seen = results(ctx); return reply(); },
      call(["generate_image", { prompt: "编辑", reference_images: [foreign] }]), reply(),
      call(["generate_image", { prompt: "编辑", reference_images: [media] }]), reply());
    await turn(r, "5", "本群");
    expect(r.imageBackend.submit).toHaveBeenCalledWith(expect.objectContaining({ reference_images: [media] }), expect.anything(), expect.anything());
    await turn(r, "5", "别群", "8");
    expect(seen).toContain("范围");
    await turn(r, "5", "外部路径");
    expect(r.imageBackend.submit).toHaveBeenCalledTimes(1);
    await turn(r, "1", "owner", "8");
    expect(r.imageBackend.submit).toHaveBeenCalledTimes(2);
  });

  it("生图写入 images/<会话>/call-<摘要>/ 并返回校验过的文件", async () => {
    let seen = "";
    const r = await rig([call(["generate_image", { prompt: "写着“你好”的海报", aspect: "16:9", count: 2 }]), ctx => { seen = results(ctx); return reply("图片好了"); }]);
    await turn(r, "5", "画图");
    const [dir] = (await fs.readdir(path.join(r.dir, "images", "group_7"))).filter(name => name.startsWith("call-"));
    expect(dir).toMatch(/^call-[0-9a-f]{16}$/);
    const file = await fs.realpath(path.join(r.dir, "images", "group_7", dir!, "result.png"));
    expect(JSON.parse(JSON.parse(seen.split("\n")[0]!)[0].text).images).toEqual([file]);
    expect(r.imageBackend.submit).toHaveBeenCalledOnce();
    expect(r.imageBackend.collect).toHaveBeenCalledOnce();
  });

  it("提交响应丢失时对账，不再次提交", async () => {
    const r = await rig([call(["generate_image", { prompt: "猫" }]), reply()]);
    r.imageBackend.collect.mockRejectedValueOnce(new UnknownJobError("lost"));
    r.imageBackend.reconcile.mockImplementation(async (...args: unknown[]) => {
      const dir = args[1] as string;
      await fs.mkdir(dir, { recursive: true });
      const file = path.join(dir, "reconciled.png"); await fs.writeFile(file, TRANSPARENT_PNG);
      return { images: [file] };
    });
    await turn(r, "5", "画猫");
    expect(r.imageBackend.submit).toHaveBeenCalledOnce(); expect(r.imageBackend.reconcile).toHaveBeenCalledOnce();
  });

  it("参考图只接受本轮输入的 incoming 附件，完成后清理远端上传", async () => {
    let seen = "";
    const r = await rig([]);
    const other = path.join(r.dir, "incoming", "other", "ref.png");
    await fs.mkdir(path.dirname(other), { recursive: true }); await fs.writeFile(other, TRANSPARENT_PNG);
    r.script.push(call(["generate_image", { prompt: "编辑", reference_images: [other] }]), ctx => { seen = results(ctx); return reply(); });
    await turn(r, "5", "改图");
    expect(seen).toMatch(/参考图/); expect(r.imageBackend.submit).not.toHaveBeenCalled();
    let own = "";
    r.script.push(() => call(["generate_image", { prompt: "编辑", reference_images: [own] }]), reply());
    await sayWithImages(r, "5", "改这张", async dir => {
      own = path.join(dir, "ref.png"); await fs.mkdir(dir, { recursive: true }); await fs.writeFile(own, TRANSPARENT_PNG); return [own];
    });
    expect(r.imageBackend.submit).toHaveBeenCalledOnce(); expect(r.imageBackend.clearReferences).toHaveBeenCalledOnce();
  });
});

describe("pi 会话隔离与映射", () => {
  it("owner 与群各自常驻会话，记忆互不可见；映射镜像写入 pi-threads.json", async () => {
    const seen: string[] = [];
    const inspect = (ctx: TranscriptContext) => { seen.push(JSON.stringify(ctx.messages)); return reply(); };
    const r = await rig([inspect, inspect, inspect, inspect]);
    await turn(r, "5", "GROUP_SEVEN_SECRET");
    await turn(r, "5", "GROUP_EIGHT_SECRET", "8");
    await turn(r, "1", "OWNER_SECRET", null);
    await turn(r, "6", "第二次");
    expect(seen[1]).not.toContain("GROUP_SEVEN_SECRET");
    expect(seen[2]).not.toMatch(/GROUP_SEVEN_SECRET|GROUP_EIGHT_SECRET/);
    expect(seen[3]).toContain("GROUP_SEVEN_SECRET");
    expect(seen[3]).not.toMatch(/GROUP_EIGHT_SECRET|OWNER_SECRET/);
    expect(new Set(Object.values(await r.pi.readThreadIds())).size).toBe(3);
    expect(await r.pi.threadHealth()).toEqual({ count: 3, keys: ["group:7", "group:8", "owner"] });
    expect(JSON.parse(await fs.readFile(path.join(r.dir, "pi-threads.json"), "utf8"))).toEqual(await r.pi.readThreadIds());
  });

  it("旧 shared 映射只退役一次，保留 owner", async () => {
    const r = await rig([reply(), reply(), reply()]);
    await turn(r, "1", "owner", null);
    await turn(r, "5", "群");
    const ids = await r.pi.readThreadIds();
    const legacy = defineDoc<{ owner: number | null; shared: number | null }>({
      kind: "cs.pi.threads", version: 1, scope: "session", initial: () => ({ owner: null, shared: null }),
    });
    await r.pi.harness.commit(async tx => {
      const doc = await tx.doc(legacy);
      Object.assign(doc, { owner: ids.owner, shared: ids["group:7"] });
      delete (doc as Record<string, unknown>)["group:7"];
    }, context);
    await r.restart();
    expect(await r.pi.readThreadIds()).toEqual({ owner: ids.owner });
    await turn(r, "5", "新群消息");
    expect((await r.pi.readThreadIds())["group:7"]).not.toBe(ids["group:7"]);
    expect((await r.pi.readThreadIds()).shared).toBeUndefined();
  });

  it("面板公开源分页读取真实历史与指定条目上下文，重置后仍列出归档", async () => {
    const r = await rig([reply("历史回复"), reply("owner 回复")]);
    await turn(r, "5", "群消息");
    await turn(r, "1", "owner 消息", null);
    const id = String((await r.pi.readThreadIds())["group:7"]);
    const sessions = await r.pi.sessionSource.listConversations();
    expect(sessions.find(item => item.id === id)).toMatchObject({ label: "group:7", scope: "group:7", status: "active" });
    expect(sessions.find(item => item.label === "owner")).toMatchObject({ scope: "owner", status: "active" });
    const first = await r.pi.sessionSource.entries(id, undefined, 1);
    expect(first.items).toHaveLength(1);
    expect(first.hasMore).toBe(true);
    const later = await r.pi.sessionSource.entries(id, first.cursor, 256);
    const userEntry = [...first.items, ...later.items].find(item => item.kind === "pi.user")!;
    const historical = await r.pi.sessionSource.context(id, String(userEntry.id));
    expect(historical.messages.some(message => message.role === "user")).toBe(true);
    expect(historical.messages.some(message => message.role === "assistant")).toBe(false);
    expect((await r.pi.sessionSource.context(id)).messages.some(message => message.role === "assistant")).toBe(true);
    await r.pi.resetThread("group:7");
    expect((await r.pi.sessionSource.listConversations()).find(item => item.id === id))
      .toMatchObject({ label: "group:7", scope: "group:7", status: "archived" });
    await expect(r.pi.sessionSource.entries("../../private")).rejects.toThrow("非法");
  });

  it("面板公开源 subscribe 通知已提交条目且取消订阅有效", async () => {
    const r = await rig([reply("初始回复"), reply("新增回复"), reply("取消后回复")]);
    await turn(r, "5", "一");
    const id = String((await r.pi.readThreadIds())["group:7"]);
    const changed = vi.fn();
    const stop = await r.pi.sessionSource.subscribe!(id, changed);
    await turn(r, "5", "二");
    await vi.waitFor(() => expect(changed).toHaveBeenCalled());
    stop();
    const count = changed.mock.calls.length;
    await turn(r, "5", "三");
    expect(changed).toHaveBeenCalledTimes(count);
  });
});

describe("pi system 提示热更新", () => {
  it("项目指引通过配置的工作区注入 system，热更新且不重复写入相同 system 条目", async () => {
    const dir = tmp("cs-pi-project-");
    const workspaceDir = path.join(dir, "workspace");
    const outer = await put(path.join(workspaceDir, "AGENTS.md"), "运维项目指引");
    const inner = await put(path.join(dir, "pi-work", "group_7", "AGENTS.md"), "会话项目指引");
    await put(path.join(dir, "AGENTS.md"), "不得加载的数据目录指引");
    const seen: TranscriptContext[] = [];
    const inspect = (ctx: TranscriptContext) => { seen.push(ctx); return reply(); };
    const r = await rig([inspect, inspect, inspect], { dir, workspaceDir });
    await turn(r, "5", "一");
    await turn(r, "5", "二");
    const system = systemOf(seen[0]!);
    expect(system).toContain(DEFAULT_PI_PROMPT);
    expect(system).toContain('<project_instructions path="' + outer + '">\n运维项目指引\n</project_instructions>');
    expect(system).toContain('<project_instructions path="' + inner + '">\n会话项目指引\n</project_instructions>');
    expect(system).not.toContain("不得加载");
    const id = String((await r.pi.readThreadIds())["group:7"]);
    const systems = async () => (await r.pi.sessionSource.entries(id, undefined, 256)).items.filter(e => e.kind === "pi.system");
    expect(await systems()).toHaveLength(1);
    await fs.writeFile(inner, "热更新后的会话项目指引", "utf8");
    await turn(r, "5", "三");
    expect(systemOf(seen[2]!)).toContain("热更新后的会话项目指引");
    expect(await systems()).toHaveLength(2);
  });

  it("技能进入 system，按需 read 正文，下一轮热更新和删除生效；off 禁用", async () => {
    const dir = tmp("cs-pi-skills-system-");
    const skillsDir = path.join(dir, "skills");
    const file = await put(path.join(skillsDir, "hello", "SKILL.md"), "---\ndescription: 第一版技能描述\n---\n按需读取的技能正文");
    await put(path.join(skillsDir, "hidden", "SKILL.md"), "---\ndescription: 隐藏技能描述\ndisable-model-invocation: true\n---\n隐藏正文");
    const seen: TranscriptContext[] = [];
    const inspect = (ctx: TranscriptContext) => { seen.push(ctx); return reply(); };
    const r = await rig([inspect, inspect, inspect, call(["read", { path: file }]), inspect], { dir, skillsDir });
    await turn(r, "5", "一");
    const system = systemOf(seen[0]!);
    expect(system).toContain("<name>hello</name>");
    expect(system).toContain("<location>" + file + "</location>");
    expect(system).not.toContain("隐藏技能描述");
    expect(system).not.toContain("按需读取的技能正文");
    await fs.writeFile(file, "---\ndescription: 更新后的技能描述\n---\n按需读取的技能正文", "utf8");
    const future = new Date(Date.now() + 2000); await fs.utimes(file, future, future);
    await turn(r, "5", "二");
    expect(systemOf(seen[1]!)).toContain("更新后的技能描述");
    await fs.unlink(file);
    await turn(r, "5", "三");
    expect(systemOf(seen[2]!)).not.toContain("<available_skills>");
    await put(file, "---\ndescription: 恢复技能描述\n---\n按需读取的技能正文");
    await turn(r, "5", "四");
    expect(results(seen[3]!)).toContain("按需读取的技能正文");

    const off = tmp("cs-pi-skills-off-");
    await put(path.join(off, "skills", "hello", "SKILL.md"), "---\ndescription: 不应加载的技能\n---\n正文");
    let offSeen!: TranscriptContext;
    const r2 = await rig([ctx => { offSeen = ctx; return reply(); }], { dir: off, skillsDir: "off" });
    await turn(r2, "5", "一");
    expect(systemOf(offSeen)).not.toContain("<available_skills>");
  });

  it("agent.md 热加载，不覆写已有内容；工作区规则只出现一次", async () => {
    const seen: TranscriptContext[] = [];
    const inspect = (ctx: TranscriptContext) => { seen.push(ctx); return reply(); };
    const r = await rig([inspect, inspect]);
    const file = path.join(r.dir, "prompts", "agent.md");
    expect(await fs.readFile(file, "utf8")).toBe(DEFAULT_PI_PROMPT);
    await turn(r, "5", "一");
    await fs.writeFile(file, "新系统提示：简短中文。", "utf8");
    const future = new Date(Date.now() + 2000); await fs.utimes(file, future, future);
    await turn(r, "5", "二");
    expect(JSON.stringify(seen[1])).toContain("新系统提示：简短中文。");
    for (const transcript of seen) {
      for (const system of transcript.messages.filter(m => m.role === "system")) for (const rule of [PI_WORKSPACE_RULE, PI_SUBAGENT_RULE]) expect(getSystemMessageText(system).split(rule)).toHaveLength(2);
    }
    expect(await new PiPromptLoader(r.dir).read()).toBe("新系统提示：简短中文。");
  });
});

describe("pi 重置与压缩", () => {
  it("重置归档映射，下一条消息新建会话；回合进行中拒绝重置", async () => {
    let release!: () => void;
    const gateOpen = new Promise<void>(resolve => { release = resolve; });
    const r = await rig([reply("一"), async () => { await gateOpen; return reply("慢"); }, reply("三")], { contextUsage: true });
    await turn(r, "5", "一");
    const before = (await r.pi.readThreadIds())["group:7"];
    await r.say("5", "慢");
    await vi.waitFor(() => expect(r.host.thread("group:7")?.turnId).toBeTruthy());
    await expect(r.pi.resetThread("group:7")).rejects.toThrow("正在处理");
    release();
    await r.idle();
    expect(await r.pi.resetThread("group:7")).toBe(before);
    expect(r.contextUsage!.get("pi", "group:7")).toMatchObject({ usedTokens: 0, turns: 0, source: "estimate", windowTokens: 200000 });
    expect((await r.pi.readThreadIds())["group:7"]).toBeUndefined();
    const archive = (await fs.readFile(path.join(r.dir, "pi-threads-archive.jsonl"), "utf8")).trim().split("\n").map(l => JSON.parse(l));
    expect(archive).toEqual([expect.objectContaining({ key: "group:7", conversation: before })]);
    await turn(r, "5", "三");
    expect((await r.pi.readThreadIds())["group:7"]).not.toBe(before);
    expect(await r.pi.resetThread("private:5")).toBeNull();
    await expect(r.pi.resetThread("../etc")).rejects.toThrow("非法会话键");
  });

  it("SQLite 归档追加失败会回滚映射清空并报告错误", async () => {
    const r = await rig([reply()]);
    await turn(r, "5", "一");
    const before = await r.pi.readThreadIds();
    const commit = r.pi.harness.commit.bind(r.pi.harness);
    const fail = vi.spyOn(r.pi.harness, "commit").mockImplementationOnce((change, ctx) => commit(async tx => {
      const doc = tx.doc.bind(tx);
      const proxy = new Proxy(tx, { get(target, key, receiver) {
        if (key === "doc") return (...args: unknown[]) => {
          if (args[0] === PiThreadsArchiveDoc) throw new Error("archive append failed");
          return Reflect.apply(doc, tx, args);
        };
        return Reflect.get(target, key, receiver);
      } });
      return change(proxy);
    }, ctx));
    try { await expect(r.pi.resetThread("group:7")).rejects.toThrow("archive append failed"); }
    finally { fail.mockRestore(); }
    expect(await r.pi.readThreadIds()).toEqual(before);
    await r.restart();
    expect(await r.pi.readThreadIds()).toEqual(before);
    expect((await r.pi.harness.snapshot(PiThreadsArchiveDoc, context))?.rows).toEqual([]);
  });

  it("提交后 JSON/JSONL 镜像写入失败，重启从 SQLite 修复且不重复归档", async () => {
    const r = await rig([reply()]);
    await turn(r, "5", "一");
    const before = await r.pi.readThreadIds();
    const rename = vi.spyOn(fs, "rename").mockRejectedValue(new Error("mirror write failed"));
    try { expect(await r.pi.resetThread("group:7")).toBe(before["group:7"]); }
    finally { rename.mockRestore(); }
    expect(JSON.parse(await fs.readFile(path.join(r.dir, "pi-threads.json"), "utf8"))).toEqual(before);
    await r.restart();
    expect(JSON.parse(await fs.readFile(path.join(r.dir, "pi-threads.json"), "utf8"))).toEqual({});
    expect(await r.pi.resetThread("group:7")).toBeNull();
    expect((await r.pi.harness.snapshot(PiThreadsArchiveDoc, context))?.rows).toHaveLength(1);
  });

  it("导入旧归档及后续重置只保留最新 200 条", async () => {
    const dir = tmp("pi-archive-rotation-");
    const rows = Array.from({ length: 205 }, (_, i) => ({ key: "group:7", conversation: 10000 + i, archived_at: new Date(i * 1000).toISOString(), reason: "legacy" }));
    await fs.writeFile(path.join(dir, "pi-threads-archive.jsonl"), rows.map(row => JSON.stringify(row)).join("\n") + "\n", "utf8");
    const r = await rig([reply()], { dir });
    expect((await r.pi.harness.snapshot(PiThreadsArchiveDoc, context))?.rows).toEqual(rows.slice(-200));
    await turn(r, "5", "一");
    const id = (await r.pi.readThreadIds())["group:7"];
    await r.pi.resetThread("group:7");
    const archive = (await r.pi.harness.snapshot(PiThreadsArchiveDoc, context))!.rows;
    expect(archive).toHaveLength(200);
    expect(archive[0]).toEqual(rows[6]); expect(archive.at(-1)?.conversation).toBe(id);
  });

  it("面板压缩：无会话 unchanged，手动摘要完成后保留映射并更新占用", async () => {
    const r = await rig([reply("第一轮回复"), reply("第二轮回复"), reply("手动压缩摘要")], { contextUsage: true });
    expect(await r.pi.compactThread("owner")).toBe("unchanged");
    await expect(r.pi.compactThread("shared")).rejects.toThrow("非法");
    await turn(r, "5", "历史事实。".repeat(30_000));
    await turn(r, "5", "recent material. ".repeat(6_000));
    const id = (await r.pi.readThreadIds())["group:7"];
    await vi.waitFor(() => expect(r.contextUsage!.get("pi", "group:7")?.turns).toBe(2));
    const before = r.contextUsage!.get("pi", "group:7")!;
    expect(await r.pi.compactThread("group:7")).toBe("compacted");
    const after = r.contextUsage!.get("pi", "group:7")!;
    expect(after).toMatchObject({ turns: before.turns, source: "compact", lastCompactionAt: expect.any(Number) });
    expect(after.usedTokens).toBeLessThan(before.usedTokens);
    expect((await r.pi.readThreadIds())["group:7"]).toBe(id);
  });

  it("按配置阈值自动压缩长期历史", async () => {
    const contexts: string[] = [];
    const respond = (ctx: TranscriptContext) => {
      const text = JSON.stringify(ctx); contexts.push(text);
      return reply(text.includes("context summarization assistant") ? "压缩摘要：保留历史事实" : "正常回答");
    };
    const r = await rig(Array.from({ length: 10 }, () => respond), { contextUsage: true, reserveTokens: 150_000, backgroundTokens: 0 });
    await turn(r, "5", "历史事实。".repeat(50_000));
    await turn(r, "5", "近期材料。".repeat(20_000));
    const conv = await convOf(r, "group:7");
    await conv.waitForIdle(context);
    expect((await conv.context(context)).entries.some(e => e.kind === "pi.compaction")).toBe(true);
    expect(contexts.some(c => c.includes("context summarization assistant"))).toBe(true);
    await vi.waitFor(() => expect(r.contextUsage!.get("pi", "group:7")!.lastCompactionAt).toBeTypeOf("number"));
    expect(r.contextUsage!.get("pi", "group:7")).toMatchObject({ turns: 2, compaction: { background: 50000, reserve: 50000 } });
  });
});

describe("pi 上下文占用", () => {
  it("每请求 recordRequest、每回合一次 recordTurn，按回合键归属", async () => {
    const events: { ticket: string; stage: string; detail: Record<string, unknown> }[] = [];
    const untap = trace.tap(e => {
      if (e.stage === "model_request" || (e.stage === "context_usage" && e.detail.source === "turn")) events.push(e);
    });
    const web = new DeepSeekWeb({ apiKey: "x", fetch: vi.fn(async () => Response.json({ results: [] })) as typeof fetch, backoffMs: 1 });
    const r = await rig([call(["web_search", { query: "usage" }]), reply("完成采集"), reply("下一回合")],
      { contextUsage: true, web, reserveTokens: 16000, backgroundTokens: 32000 });
    try {
      const key = await turn(r, "5", "采集");
      const ticket = "turn:" + turnOf(r, key);
      const conv = await convOf(r, "group:7");
      const messages = (await conv.context(context)).entries.flatMap(e => e.model ?? []).filter(m => m.role === "assistant");
      expect(messages).toHaveLength(2);
      const actual = messages[1]!.usage;
      await vi.waitFor(() => expect(r.contextUsage!.get("pi", "group:7")).toMatchObject({
        usedTokens: actual.input + actual.cacheRead + actual.cacheWrite, windowTokens: 200000, turns: 1, source: "turn",
        compaction: { background: 152000, reserve: 184000 } }));
      expect(events.map(e => e.stage)).toEqual(["model_request", "model_request", "context_usage"]);
      expect(events.slice(0, 2).map(e => e.detail)).toEqual(messages.map((m, index) => expect.objectContaining({
        backend: "pi", key: "group:7", ticket, seq: index + 1, turn: 1 })));
      const next = await turn(r, "5", "下一条");
      await vi.waitFor(() => expect(events).toHaveLength(5));
      expect(events[3]).toMatchObject({ ticket: "turn:" + turnOf(r, next), stage: "model_request", detail: { seq: 1, turn: 2 } });
      expect(events[4]).toMatchObject({ stage: "context_usage", detail: { turns: 2 } });
    } finally { untap(); }
  });

  it("回合完成时缺少请求样本仍只计一个回合并保留原占用", async () => {
    const r = await rig([reply("第一轮"), reply("没有用量")], { contextUsage: true });
    await turn(r, "5", "一");
    await vi.waitFor(() => expect(r.contextUsage!.get("pi", "group:7")?.turns).toBe(1));
    const before = r.contextUsage!.get("pi", "group:7")!;
    const last = vi.spyOn(PiContextObserver.prototype, "lastRequest").mockReturnValue(undefined);
    try {
      await turn(r, "5", "二");
      await vi.waitFor(() => expect(r.contextUsage!.get("pi", "group:7")).toEqual({ ...before, turns: 2 }));
    } finally { last.mockRestore(); }
  });

  it("observer 在摘要提交后立即估算，重复刷新不增加回合；读取失败保留记录", async () => {
    const r = await rig([reply("之前的回复")], { contextUsage: true });
    await turn(r, "5", "一");
    await vi.waitFor(() => expect(r.contextUsage!.get("pi", "group:7")?.turns).toBe(1));
    const conv = await convOf(r, "group:7");
    await conv.commit(tx => tx.appendEntry(conv.id, { kind: CompactionEntry.kind, head: "self",
      model: [{ role: "user", content: "短摘要", timestamp: Date.now() }], data: { reason: "manual" } }), context);
    await vi.waitFor(() => expect(r.contextUsage!.get("pi", "group:7")).toMatchObject({ source: "compact", turns: 1 }));
    const expected = estimateContextTokens((await conv.context(context)).messages).tokens;
    expect(r.contextUsage!.get("pi", "group:7")?.usedTokens).toBe(expected);
    await refreshPiCompactionUsage(conv, "group:7", r.contextUsage!);
    expect(r.contextUsage!.get("pi", "group:7")).toMatchObject({ usedTokens: expected, turns: 1 });
    const before = r.contextUsage!.get("pi", "group:7");
    const read = vi.spyOn(conv, "context").mockRejectedValueOnce(new Error("unavailable"));
    const info = vi.spyOn(log, "info");
    try {
      await expect(refreshPiCompactionUsage(conv, "group:7", r.contextUsage!)).resolves.toBeUndefined();
      expect(r.contextUsage!.get("pi", "group:7")).toEqual(before);
    } finally { read.mockRestore(); info.mockRestore(); }
  });

  it("重启后从会话历史回填占用，不调用模型", async () => {
    const r = await rig([reply("第一轮"), reply("第二轮")], { contextUsage: true });
    await turn(r, "5", "一");
    await turn(r, "5", "二");
    await vi.waitFor(() => expect(r.contextUsage!.get("pi", "group:7")?.turns).toBe(2));
    await r.contextUsage!.flush();
    await fs.unlink(path.join(r.dir, "context-usage.json"));
    const calls = r.faux.state.callCount;
    await r.restart();
    expect(r.contextUsage!.get("pi", "group:7")).toMatchObject({ turns: 2, source: "turn", windowTokens: 200000 });
    expect(r.faux.state.callCount).toBe(calls);
  });

  it("deepseek-flash 使用 pi-ai 的 1000000 窗口与默认实际压缩位置", () => {
    const model = builtinModels().getModel("deepseek", "deepseek-flash")!;
    expect(piContextCapacity(model.contextWindow)).toEqual({ windowTokens: 1000000,
      compaction: { background: 950848, reserve: 983616 } });
  });
});

it("pi 历史工具记录回合与会话归属并发出轻量 trace", async () => {
  const obs = new ObsStore(tmp());
  try {
    const r = await rig([call(["qq_recent", {}]), reply()], { instrumentation: MemoryInstrumentation.fromDb(obs.db) });
    r.history.ingest(r.message("6", "历史记录", "7", { message_id: "m" }));
    const events: string[] = [];
    const off = trace.tap(e => { if (e.ticket.startsWith("turn:pi:")) events.push(e.stage); });
    try {
      const key = await turn(r, "5", "回顾");
      const session = String((await r.pi.readThreadIds())["group:7"]);
      expect(obs.db.prepare("SELECT * FROM recall_events").get()).toMatchObject({ backend: "pi", ticket: turnOf(r, key), session,
        task_id: expect.stringMatching(/^\d+$/), tool: "qq_recent", scope_hint: "group:7" });
      expect(events).toContain("memory_recall");
    } finally { off(); }
  } finally { obs.close(); }
});

describe("pi 运行时模型设置", () => {
  it("开轮读取当前模型和快照档位；没有模型快照的回合沿用当前模型", async () => {
    const calls: { model: string; reasoning: unknown }[] = [];
    const step = (_ctx: TranscriptContext, extra?: { model: string; reasoning: unknown }) => { calls.push(extra!); return reply(); };
    let modelId = "runtime";
    const r = await rig([step, step], { extraModels: [{ id: "runtime", contextWindow: 400000, reasoning: true }], contextUsage: true,
      currentModel: provider => ({ provider, modelId }), settings: () => ({ piModel: modelId, piThinkingLevel: "high" }) });
    await turn(r, "5", "一");
    await vi.waitFor(() => expect(r.contextUsage!.get("pi", "group:7")?.windowTokens).toBe(400000));
    modelId = "test";
    await turn(r, "5", "二");
    expect(calls).toEqual([{ model: "runtime", reasoning: "high" }, { model: "test", reasoning: undefined }]);
  });

  it("设置中的模型不存在时 warn 并回退启动模型", async () => {
    let modelId: string | undefined;
    const warn = vi.spyOn(log, "warn");
    try {
      const r = await rig([(_ctx, extra) => { modelId = extra!.model; return reply(); }],
        { currentModel: () => ({ provider: "missing", modelId: "gone" }), settings: () => ({ piModel: "gone" }) });
      await turn(r, "5", "一");
      expect(modelId).toBe("test");
      expect(warn).toHaveBeenCalledWith("pi runtime model unavailable; using startup model", { provider: "missing", model: "gone" });
    } finally { warn.mockRestore(); }
  });
});

describe("pi send_message 工具", () => {
  it("稳定 toolCallId 作为调用键：Outbox 行键 <会话>:<callId>，同一回合第四条也能发出，附件从工作区发送", async () => {
    let seen!: TranscriptContext;
    const r = await rig([]);
    const work = path.join(r.dir, "pi-work", "group_7"); await fs.mkdir(work, { recursive: true });
    for (const name of ["0", "1"]) {
      await fs.writeFile(path.join(work, name + ".txt"), "文件" + name);
      await fs.writeFile(path.join(work, name + ".png"), Buffer.concat([TRANSPARENT_PNG, Buffer.from(name)]));
    }
    r.script.push(call(["send_message", { text: "附件", images: ["0.png", "1.png"], files: [{ path: "0.txt" }, { path: "1.txt" }] }]),
      call(["send_message", { text: "第二条" }]), call(["send_message", { text: "第三条" }]), call(["send_message", { text: "第四条" }]),
      ctx => { seen = ctx; return reply("仅留存"); });
    const key = await turn(r, "5", "发几条");
    const tools = toolResults(seen);
    expect(tools.every(t => !t.isError)).toBe(true);
    const rows = r.bridge.outbox.listOutboxByTurn(turnOf(r, key));
    expect(rows.map(row => row.key)).toEqual(tools.map(t => "group:7:" + t.toolCallId));
    expect(rows[0]!.files.map(x => x.status)).toEqual(["sent", "sent"]);
    expect(r.texts("7")).toEqual(["附件", "第二条", "第三条", "第四条"]);
  });

  it.each(["group:7", "group:8"])("已召回媒体按本轮读取范围校验：%s", async scope => {
    const r = await rig([]);
    const media = await mediaFixture(r.history, r.dir, scope);
    let seen!: TranscriptContext;
    r.script.push(call(["send_message", { text: "图", images: [media] }]),
      call(["send_message", { text: "文件", files: [{ path: path.join(r.dir, "prompts", "agent.md") }] }]),
      ctx => { seen = ctx; return reply(); });
    await turn(r, "5", "发图");
    const tools = toolResults(seen);
    expect(!!tools[0]!.isError).toBe(scope === "group:8");
    expect(tools[1]!.isError).toBe(true);
  });

  it("不确定的发送以非错误工具结果返回，换调用键同文重试不再发送", async () => {
    let seen!: TranscriptContext;
    const r = await rig([call(["send_message", { text: "可能送达" }]), call(["send_message", { text: "可能送达" }]),
      ctx => { seen = ctx; return reply(); }]);
    const original = r.call.getMockImplementation()!;
    let failed = false;
    r.call.mockImplementation(async (action: string, params?: Record<string, unknown>) => {
      if (action === "send_group_msg" && !failed) { failed = true; r.sent.push({ action, params: params! }); throw new Error("回执丢失"); }
      return original(action, params);
    });
    const key = await turn(r, "5", "发");
    const tools = toolResults(seen);
    expect(tools).toHaveLength(2);
    expect(tools.every(t => !t.isError)).toBe(true);
    expect(JSON.stringify(tools)).toContain("消息可能已送达，不要重发");
    expect(r.bridge.outbox.listOutboxByTurn(turnOf(r, key))).toHaveLength(1);
    expect(r.sent.filter(s => s.action === "send_group_msg")).toHaveLength(1);
  });
});

describe("pi 身份随发言人切换（§7.3）", () => {
  it("owner 群回合 all 读取但留在群线程；工具与身份随群内发言人切换", async () => {
    const observed: TranscriptContext[] = [];
    const inspect = (ctx: TranscriptContext) => { observed.push(ctx); return reply(); };
    const r = await rig([
      call(["qq_recent", {}]),
      call(["auth_grant", { user: "qq:6", caps: ["send"], targets: ["qq:group:8"], scopes: ["group:7"] }]),
      call(["send_message", { target: "qq:group:8", text: "跨会话消息" }]),
      call(["send_message", { text: "来源群回复" }]), inspect,
      call(["auth_list", {}]), inspect,
      call(["send_message", { target: "qq:group:8", text: "撤销后不能发" }]), inspect,
    ]);
    r.history.ingest(r.message("6", "owner 可读取的私聊内容", null, { message_id: "private-owner" }));
    await turn(r, "1", "owner 在群里");
    const ids = await r.pi.readThreadIds();
    expect(ids.owner).toBeUndefined();
    expect(results(observed[0]!)).toContain("owner 可读取的私聊内容");
    expect(r.texts("8")).toEqual(["跨会话消息"]);
    expect(r.texts("7")).toEqual(["来源群回复"]);
    const conv = await convOf(r, "group:7");
    const tools = () => conv.agent(context).then(a => a.tools);
    expect((await tools()).map(t => t.name)).toContain("auth_grant");
    await turn(r, "6", "成员");
    expect((await tools()).some(t => t.name.startsWith("auth_"))).toBe(false);
    expect((await tools()).find(t => t.name === "send_message")!.parameters).toHaveProperty("properties.target");
    expect(toolResults(observed[1]!).at(-1)).toMatchObject({ isError: true });
    await r.grants.panel("auth_revoke", { user: "qq:6" });
    await turn(r, "6", "撤销后");
    expect((await tools()).find(t => t.name === "send_message")!.parameters).not.toHaveProperty("properties.target");
    expect(toolResults(observed[2]!).at(-1)).toMatchObject({ isError: true });
    expect(r.texts("8")).toEqual(["跨会话消息"]);
    expect(await r.pi.readThreadIds()).toEqual(ids);
  });

  it("两个 owner 账号共用 owner 会话与历史，第二账号保留授权工具", async () => {
    let seen!: TranscriptContext;
    const r = await rig([reply("主账号的历史答复"), call(["auth_list", {}]), transcript => { seen = transcript; return reply("继续对话"); }],
      { owners: ["9", "1"] });
    await turn(r, "9", "第一个号", null);
    await turn(r, "1", "第二个号", null);
    expect(JSON.stringify(seen.messages)).toContain("主账号的历史答复");
    const result = toolResults(seen).find(m => m.toolName === "auth_list");
    expect(result?.isError).not.toBe(true);
    expect(Object.keys(await r.pi.readThreadIds())).toEqual(["owner"]);
  });

  it("定时工具按回合身份切换：owner、授权人、无权成员、定时运行只剩 schedule_control", async () => {
    const f = await scheduleToolsFixture(), seen: TranscriptContext[] = [];
    const inspect = (ctx: TranscriptContext) => { seen.push(ctx); return reply(); };
    const r = await rig([
      call(["schedule_create", f.args]), inspect,
      call(["schedule_create", f.args]), inspect,
      call(["schedule_list", {}]), inspect,
      call(["schedule_control", { action: "pause", reason: "等待更新" }]), inspect,
    ], { scheduleTools: f.tools, owners: ["1"] });
    // 定时工具的授权表在装置自己的 harness 上
    const visible = async () => (await (await convOf(r, "group:7")).agent(context)).tools.map(t => t.name).filter(n => n.startsWith("schedule_"));
    await turn(r, "1", "建一个");
    expect(await visible()).toEqual([...SCHEDULE_MANAGEMENT_TOOLS]);
    expect(toolResults(seen[0]!).at(-1)?.isError).not.toBe(true);
    const own = (await f.service.list("qq:1"))[0]!;
    expect(own).toMatchObject({ conversation: "group:7", created_by: "qq:1" });
    await f.grants.panel("auth_grant", { user: "qq:6", caps: ["schedule"], scopes: ["group:7"] });
    await turn(r, "6", "我也建");
    expect(await visible()).toEqual([...SCHEDULE_MANAGEMENT_TOOLS]);
    expect((await f.service.list("qq:6"))[0]?.created_by).toBe("qq:6");
    await f.grants.panel("auth_revoke", { user: "qq:6" });
    await turn(r, "6", "再看看");
    expect(await visible()).toEqual([]);
    expect(toolResults(seen[2]!).at(-1)).toMatchObject({ isError: true });
    // 定时回合：同一定时输入写入装置的 Inbox 后交给宿主
    const bound = await f.scheduled(own.id);
    const input = f.bridge.inbox.getInbound(bound.inputKey!)!;
    r.bridge.inbox.openScheduledInput({ key: input.key, scope: input.scope, thread_key: input.thread_key, creator: "qq:1", text: input.text, time: input.time });
    await r.inbox.deliverScheduled(input.key);
    await r.idle();
    expect(await visible()).toEqual(["schedule_control"]);
    expect((await f.service.get(own.id))?.status).toBe("paused");
  });
});

describe("pi 重启恢复", () => {
  it("工具执行中重启：回合续跑，安全工具重放一次，只得到一个回答", async () => {
    let started = 0;
    const http: typeof fetch = async (_url, init) => {
      started++;
      if (started === 1) {
        await new Promise<void>(resolve => init?.signal?.addEventListener("abort", () => resolve(), { once: true }));
        throw new Error("aborted");
      }
      return Response.json({ results: [{ title: "资料", summary: "摘要", url: "https://example.com", rerank_score: 1 }] });
    };
    const web = new DeepSeekWeb({ apiKey: "x", fetch: http, backoffMs: 1, resolve: async () => [{ address: "93.184.216.34", family: 4 }] });
    let resumed: TranscriptContext | undefined;
    const r = await rig([call(["web_search", { query: "旧请求" }]), ctx => { resumed = ctx; return call(["send_message", { text: "旧请求完成" }]); }, reply()], { web });
    await r.say("5", "查一下");
    await vi.waitFor(() => expect(started).toBe(1));
    await r.restart();
    await r.idle(20_000);
    expect(started).toBe(2);
    expect(results(resumed!)).toContain("资料");
    expect(r.texts("7")).toEqual(["旧请求完成"]);
  });
});

describe("DeepSeek tools", () => {
  it("sorts rerank_score and bounds search/fetch output", async () => {
    const http = vi.fn().mockResolvedValueOnce(Response.json({ results: [
      { title: "低", rerank_score: 1 }, { title: "高", rerank_score: 2, summary: "字".repeat(3000) },
    ] })).mockResolvedValueOnce(Response.json({ data: { content: "文".repeat(5000) } }));
    const web = new DeepSeekWeb({ apiKey: "fake", fetch: http, resolve: async () => [{ address: "8.8.8.8", family: 4 }] });
    const search = await web.search("关键词"); expect(search.startsWith("高")).toBe(true); expect(search.length).toBeLessThanOrEqual(2500);
    expect((await web.page("https://example.com")).length).toBeLessThanOrEqual(4000);
  });
  it("retries 429 once and never retries other 4xx", async () => {
    const http = vi.fn().mockResolvedValueOnce(new Response(null, { status: 429 })).mockResolvedValueOnce(Response.json({ results: [] }));
    await new DeepSeekWeb({ apiKey: "fake", fetch: http, backoffMs: 1 }).search("q"); expect(http).toHaveBeenCalledTimes(2);
    for (const status of [400, 401, 403, 404, 429]) {
      const failed = vi.fn(async () => new Response("secret body", { status }));
      await expect(new DeepSeekWeb({ apiKey: "fake", fetch: failed, backoffMs: 1 }).search("q")).rejects.toThrow(`HTTP ${status}`);
      expect(failed).toHaveBeenCalledTimes(status === 429 ? 2 : 1);
    }
  });
  it.each(["file:///data/secrets", "http://localhost", "http://host.docker.internal", "http://127.0.0.1", "http://[::1]", "http://[::ffff:127.0.0.1]", "https://user:pass@example.com", "http://10.1.2.3", "http://169.254.169.254"])("rejects private URL %s before HTTP", async url => {
    await expect(publicPageUrl(url)).rejects.toThrow();
  });
  it("rejects DNS answers containing any private address", async () => {
    await expect(publicPageUrl("https://example.com", async () => [{ address: "8.8.8.8", family: 4 }, { address: "192.168.1.1", family: 4 }])).rejects.toThrow(/内部网络/);
  });
});

