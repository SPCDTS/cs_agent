import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { MemoryStore } from "../../src/context/memory/store.js";
import { PROFILE_NONE, ProfileStore } from "../../src/context/memory/profile.js";
import { runRights } from "../../src/agent/host/identity.js";
import { MEMORY_CHILD_READONLY, MEMORY_PROFILE_OWNER_ONLY, MEMORY_UNVERIFIED, MemoryService, memoryAccess, memoryToolNames, type MemoryBinding } from "../../src/agent/memory/service.js";
import { renderMemorySection } from "../../src/agent/memory/render.js";
import { isSubagentExcludedTool } from "../../src/agent/pi-tools/subagent.js";
import { MEMORY_TOOLS } from "../../src/agent/memory/tools.js";
import { Trace, type ObsEvent } from "../../src/shared/trace.js";
import type { TurnIdentity } from "../../src/channel/types.js";
import { tmp } from "./helpers.js";

const clean: (() => void)[] = [];
afterEach(() => { for (const fn of clean.splice(0)) fn(); });

const OWNERS = ["1"];
/** 2026-10-26 12:00 北京时间 */
const NOW = Date.UTC(2026, 9, 26, 4);
const bind = (threadKey: string, identity: TurnIdentity, extra: Partial<MemoryBinding> = {}): MemoryBinding => ({
  threadKey, scope: threadKey === "owner" ? "private:1" : threadKey, identity, inputs: [], turnId: "pi:t1", ...extra,
});
const user = (sender: string): TurnIdentity => ({ kind: "user", sender });
const ownerTurn = (extra: Partial<MemoryBinding> = {}) => bind("owner", user("1"), extra);
const groupTurn = (sender: string, extra: Partial<MemoryBinding> = {}) => bind("group:7", user(sender), extra);

function rig(maxChars?: number) {
  const dir = tmp("cs-memory-service-");
  const store = new MemoryStore(dir, () => Math.floor(NOW / 1000)), profiles = new ProfileStore(dir);
  clean.push(() => store.close());
  const events: ObsEvent[] = [];
  let n = 0;
  const trace = new Trace({ append: e => { const event = { id: ++n, ...e, detail_json: JSON.stringify(e.detail ?? {}) } as ObsEvent; events.push(event); return event; } });
  const inbound = new Map([["in-owner", { scope: "private:1", message_id: "9031" }], ["in-group", { scope: "group:7", message_id: "8812" }]]);
  const service = new MemoryService({ store, profiles, owners: OWNERS, trace, maxChars,
    inbound: key => inbound.get(key) ?? null,
    scopeLabel: scope => scope === "group:7" ? "群 家庭群" : scope === "private:1" ? "owner 私聊" : scope });
  return { dir, store, profiles, service, events };
}

describe("§5 权限表：按 runRights 求可读 / 可写命名空间", () => {
  const access = (b: MemoryBinding, child = false) => memoryAccess(runRights(b, OWNERS), child);

  it.each<[string, MemoryBinding, boolean, { read: unknown; write: string[]; profile?: string; routeSubjects: boolean }]>([
    ["owner 私聊、owner 本人：读全部、写 owner、可改 owner 画像", ownerTurn(), false, { read: "all", write: ["owner"], profile: "owner", routeSubjects: true }],
    ["owner 私聊的定时回合：同 owner 本人", bind("owner", { kind: "scheduled", creator: "1" }), false, { read: "all", write: ["owner"], profile: "owner", routeSubjects: true }],
    ["群线程里的 owner：只读写本群，可改本群画像", groupTurn("1"), false, { read: ["group:7"], write: ["group:7"], profile: "group:7", routeSubjects: false }],
    ["群线程里的其他人：只读写本群，没有画像", groupTurn("5"), false, { read: ["group:7"], write: ["group:7"], routeSubjects: false }],
    ["其他私聊：读写本人", bind("private:5", user("5")), false, { read: ["private:5"], write: ["private:5"], routeSubjects: false }],
    ["群里没有确证的人（唤醒无继承）：只读本群、不可写", bind("group:7", { kind: "wake" }), false, { read: ["group:7"], write: [], routeSubjects: false }],
    ["owner 私聊没有确证的人：只读 owner、不可写", bind("owner", { kind: "wake" }), false, { read: ["owner"], write: [], routeSubjects: false }],
    ["唤醒回合继承 owner：同 owner 本人", bind("owner", { kind: "wake", inherited: { kind: "user", person: "1", owner: true } }), false,
      { read: "all", write: ["owner"], profile: "owner", routeSubjects: true }],
    ["子 agent（派出者是 owner）：继承读范围，没有写", bind("owner", { kind: "wake", inherited: { kind: "user", person: "1", owner: true } }), true,
      { read: "all", write: [], routeSubjects: false }],
  ])("%s", (_name, binding, child, expected) => {
    const a = access(binding, child);
    expect({ read: a.read, write: a.write, routeSubjects: a.routeSubjects, ...(a.profile ? { profile: a.profile } : {}) }).toEqual(expected);
  });

  it("工具可见性：读工具恒有；写工具要有可写命名空间；mem_profile 只在 owner 本人的回合；子 agent 只有读工具", () => {
    expect(memoryToolNames(access(ownerTurn()))).toEqual([...MEMORY_TOOLS]);
    expect(memoryToolNames(access(groupTurn("5")))).toEqual(["mem_search", "mem_list", "mem_remember", "mem_update", "mem_forget"]);
    expect(memoryToolNames(access(bind("group:7", { kind: "wake" })))).toEqual(["mem_search", "mem_list"]);
    expect(memoryToolNames(access(ownerTurn(), true))).toEqual(["mem_search", "mem_list"]);
    // pi 子会话的工具集排除写工具（与 send_message、auth_* 同一份排除名单）
    for (const name of MEMORY_TOOLS) expect(isSubagentExcludedTool(name)).toBe(name !== "mem_search" && name !== "mem_list");
  });
});

describe("工具语义", () => {
  it("owner 私聊记下的条目带来源；群里查不到 owner 条目，owner 私聊能查到群条目", async () => {
    const r = rig();
    const saved = await r.service.tool(ownerTurn({ inputKey: "in-owner" }), "mem_remember", { text: "住在上海浦东，工作日通勤约 50 分钟。", kind: "fact", subject: "self", since: "2026-09-12" });
    expect(saved).toMatch(/^已记住：#1 \[fact\] \(2026-09-12 起\) 住在上海浦东，工作日通勤约 50 分钟。 ← 来源 owner 私聊 #9031$/);
    expect(r.store.get(1)).toMatchObject({ ns: "owner", author: "qq:1", source_scope: "private:1", source_message_id: "9031", source_turn_id: "pi:t1", confidence: 1 });
    await r.service.tool(groupTurn("5", { inputKey: "in-group" }), "mem_remember", { text: "家庭群每周五晚上聚餐", kind: "fact" });
    expect(await r.service.tool(groupTurn("5"), "mem_search", { query: "浦东" })).toBe("没有找到匹配的记忆。");
    expect(await r.service.tool(groupTurn("1"), "mem_search", { query: "浦东" })).toBe("没有找到匹配的记忆。");
    expect(await r.service.tool(groupTurn("5"), "mem_list", {})).toBe("#2 [fact] 家庭群每周五晚上聚餐 ← 来源 群 家庭群 #8812");
    const all = await r.service.tool(ownerTurn(), "mem_list", {});
    expect(all.split("\n")).toHaveLength(2);
    // 群里的人不能改、不能遗忘 owner 的条目；提示与不存在相同
    await expect(r.service.tool(groupTurn("5"), "mem_forget", { id: 1, reason: "试试" })).rejects.toThrow("没有可修改的记忆 #1");
    await expect(r.service.tool(groupTurn("5"), "mem_update", { id: 999, text: "x" })).rejects.toThrow("没有可修改的记忆 #999");
  });

  it("person 为空的回合与子 agent 不可写；未确证的群回合仍可读本群", async () => {
    const r = rig();
    await r.service.tool(groupTurn("5"), "mem_remember", { text: "群规：周末不发工作消息", kind: "rule" });
    await expect(r.service.tool(bind("group:7", { kind: "wake" }), "mem_remember", { text: "x", kind: "fact" })).rejects.toThrow(MEMORY_UNVERIFIED);
    await expect(r.service.tool(bind("owner", { kind: "wake" }), "mem_forget", { id: 1, reason: "x" })).rejects.toThrow(MEMORY_UNVERIFIED);
    await expect(r.service.tool(ownerTurn({ child: true }), "mem_remember", { text: "x", kind: "fact" })).rejects.toThrow(MEMORY_CHILD_READONLY);
    expect(await r.service.tool(bind("group:7", { kind: "wake" }), "mem_search", { query: "周末" })).toContain("#1 [rule]");
    expect(await r.service.tool(ownerTurn({ child: true }), "mem_search", { query: "周末" })).toContain("#1 [rule]");
  });

  it("owner 私聊里 subject 写成会话键时记入该会话；取代、更新、遗忘写版本", async () => {
    const r = rig();
    expect(await r.service.tool(ownerTurn(), "mem_remember", { text: "下周六家庭聚会在外婆家", kind: "episode", subject: "group:7", since: "2026-10-31" }))
      .toContain("#1 [episode] (2026-10-31)");
    expect(r.store.get(1)?.ns).toBe("group:7");
    // 群里的 subject 只是文本，不改命名空间
    await r.service.tool(groupTurn("1"), "mem_remember", { text: "群主是阿强", kind: "fact", subject: "private:9" });
    expect(r.store.get(2)?.ns).toBe("group:7");
    await r.service.tool(groupTurn("5"), "mem_remember", { text: "聚会改到周日", kind: "fact" });
    expect(await r.service.tool(groupTurn("5"), "mem_remember", { text: "聚会改到下周日", kind: "fact", supersedes: 3 })).toContain("（取代 #3）");
    expect(r.store.get(3)?.status).toBe("superseded");
    expect(await r.service.tool(groupTurn("5"), "mem_remember", { text: "聚会改到下周日。", kind: "fact" })).toContain("已有相同的记忆，未重复记录");
    await r.service.tool(groupTurn("5"), "mem_remember", { text: "周四前把周报模板发给群主", kind: "commitment", due_at: "2026-10-30" });
    expect(await r.service.tool(groupTurn("5"), "mem_update", { id: 5, done_at: "2026-10-29 18:30" })).toContain("(已完成 2026-10-29 18:30)");
    await expect(r.service.tool(groupTurn("5"), "mem_update", { id: 4, due_at: "2026-11-01" })).rejects.toThrow(/只用于 commitment/);
    await expect(r.service.tool(groupTurn("5"), "mem_update", { id: 3, text: "改旧的" })).rejects.toThrow(/只能修改 active/);
    expect(await r.service.tool(groupTurn("5"), "mem_forget", { id: 4, reason: "说错了" })).toContain("已遗忘 #4");
    expect(r.store.versions(4).map(v => [v.by, v.reason])).toEqual([["qq:5", "remember"], ["qq:5", "说错了"]]);
    // owner 私聊可以管理别的命名空间的条目
    expect(await r.service.tool(ownerTurn(), "mem_forget", { id: 2, reason: "已换群主" })).toContain("已遗忘 #2");
    expect(r.service.restoreFromDashboard(4).status).toBe("active");
    expect(() => r.service.restoreFromDashboard(4)).toThrow(/无需恢复/);
    expect(r.service.forgetFromDashboard(4).status).toBe("forgotten");
    expect(r.store.versions(4).at(-1)?.by).toBe("dashboard");
  });

  it("参数校验与秘密检测", async () => {
    const r = rig();
    await expect(r.service.tool(ownerTurn(), "mem_remember", { text: "x", kind: "wish" })).rejects.toThrow(/参数无效：kind/);
    await expect(r.service.tool(ownerTurn(), "mem_remember", { text: "x", kind: "fact", extra: 1 })).rejects.toThrow(/参数无效/);
    await expect(r.service.tool(ownerTurn(), "mem_remember", { text: "x", kind: "fact", since: "2026-02-30" })).rejects.toThrow(/日期/);
    await expect(r.service.tool(ownerTurn(), "mem_remember", { text: "服务器密码 password=hunter2abc", kind: "fact" })).rejects.toThrow(/凭据/);
    await expect(r.service.tool(ownerTurn(), "mem_nope", {})).rejects.toThrow(/未知的记忆工具/);
  });

  it("输出总量受字数上限约束并说明未显示的条数；检索记召回统计并写 memory_recall / memory_write 事件（不记正文）", async () => {
    const r = rig(200);
    for (let i = 0; i < 6; i++) await r.service.tool(ownerTurn({ turnId: `pi:w${i}` }), "mem_remember", { text: `关于项目 X 的第 ${i} 条较长的记录，用来测试裁剪`, kind: "fact" });
    const text = await r.service.tool(ownerTurn(), "mem_search", { query: "项目 X" });
    expect(text.length).toBeLessThanOrEqual(200);
    expect(text).toMatch(/（另有 \d+ 条未显示，请缩小范围）$/);
    const recall = r.events.filter(e => e.stage === "memory_recall").at(-1)!;
    const detail = JSON.parse(recall.detail_json);
    expect(recall.key).toBe("turn:pi:t1");
    expect(detail).toMatchObject({ tool: "mem_search", max_chars: 200 });
    expect(detail.returned_count + detail.dropped_count).toBe(6);
    expect(recall.detail_json).not.toContain("项目 X");
    for (const id of detail.ids as number[]) expect(r.store.get(id)?.recall_count).toBe(1);
    const write = r.events.find(e => e.stage === "memory_write")!;
    expect(JSON.parse(write.detail_json)).toMatchObject({ tool: "mem_remember", author: "qq:1", ns: "owner", kind: "fact", superseded: null });
    expect(write.detail_json).not.toContain("项目 X");
  });

  it("画像只在 owner 本人的回合、只写本线程命名空间；revision 不符返回当前内容", async () => {
    const r = rig();
    await expect(r.service.tool(groupTurn("5"), "mem_profile", { text: "群简介", revision: PROFILE_NONE })).rejects.toThrow(MEMORY_PROFILE_OWNER_ONLY);
    await expect(r.service.tool(ownerTurn({ child: true }), "mem_profile", { text: "x", revision: PROFILE_NONE })).rejects.toThrow(MEMORY_PROFILE_OWNER_ONLY);
    expect(await r.service.tool(groupTurn("1"), "mem_profile", { text: "家庭群：爸妈和兄弟姐妹", revision: PROFILE_NONE })).toContain("画像已保存");
    expect((await r.profiles.read("group:7")).text).toBe("家庭群：爸妈和兄弟姐妹");
    expect((await r.profiles.read("owner")).text).toBe("");
    await r.service.tool(ownerTurn(), "mem_profile", { text: "称呼：老王", revision: PROFILE_NONE });
    await expect(r.service.tool(ownerTurn(), "mem_profile", { text: "称呼：小王", revision: PROFILE_NONE }))
      .rejects.toThrow(/画像已被修改，当前 revision=[0-9a-f]{24}，当前内容如下[\s\S]*称呼：老王/);
    await expect(r.service.tool(ownerTurn(), "mem_profile", { text: "token: abcdefghijklmnop", revision: (await r.profiles.read("owner")).revision })).rejects.toThrow(/凭据/);
  });

  it("revision 冲突时返回的当前画像按字数上限截断并注明；超限画像不进提示，mem_profile 提示重写", async () => {
    const r = rig();
    // 缺省上限 2500 字：接近 4 KiB 的英文画像（单字节字符）就会超出
    const { revision } = await r.profiles.write("owner", "Prefers short plain-text replies.\n".repeat(120), PROFILE_NONE);
    const error = await r.service.tool(ownerTurn(), "mem_profile", { text: "新", revision: "stale" }).catch((e: Error) => e.message);
    expect(error.length).toBeLessThanOrEqual(2500);
    expect(error).toMatch(/当前 revision=[0-9a-f]{24}[\s\S]*…（已截断）$/);
    // 运维手改到 4 KiB 以上：渲染为空，mem_profile 报超限并给 revision，凭它重写成功
    await fs.writeFile(r.profiles.file("owner"), "超".repeat(2000), "utf8");
    expect(await r.service.render("owner")).toBeUndefined();
    const oversize = await r.service.tool(ownerTurn(), "mem_profile", { text: "精简", revision }).catch((e: Error) => e.message);
    expect(oversize).toContain("超过 4 KiB 上限");
    const current = /revision=([0-9a-f]{24})/.exec(oversize)![1]!;
    expect(await r.service.tool(ownerTurn(), "mem_profile", { text: "精简", revision: current })).toContain("画像已保存");
    expect(await r.service.render("owner")).toContain("精简");
  });

  it("画像写入与条目写入共用每轮 20 次额度，下一轮重新计数；遗忘原因也过秘密检测", async () => {
    const r = rig();
    const turn = ownerTurn({ turnId: "pi:mixed" });
    for (let i = 0; i < 19; i++) await r.service.tool(turn, "mem_remember", { text: `第 ${i} 条`, kind: "fact" });
    await r.service.tool(turn, "mem_profile", { text: "称呼：老王", revision: PROFILE_NONE });
    await expect(r.service.tool(turn, "mem_profile", { text: "称呼：小王", revision: (await r.profiles.read("owner")).revision })).rejects.toThrow(/上限（20 次）/);
    expect(await r.service.tool(ownerTurn({ turnId: "pi:next" }), "mem_remember", { text: "下一轮", kind: "fact" })).toContain("已记住");
    await expect(r.service.tool(ownerTurn(), "mem_forget", { id: 1, reason: "密码是 password=hunter2abc" })).rejects.toThrow(/凭据/);
    expect(r.store.get(1)?.status).toBe("active");
    expect(r.store.versions(1)).toHaveLength(1);
  });

  it("mem_remember 的正文与已有条目相同时，supersedes 照样生效并写 memory_write", async () => {
    const r = rig();
    await r.service.tool(ownerTurn(), "mem_remember", { text: "住上海", kind: "fact" });
    await r.service.tool(ownerTurn(), "mem_remember", { text: "住杭州", kind: "fact" });
    expect(await r.service.tool(ownerTurn(), "mem_remember", { text: "住杭州", kind: "fact", supersedes: 1 })).toBe("已有相同的记忆，未重复记录：#2 [fact] 住杭州 ← 来源 owner 私聊（取代 #1）");
    expect(r.store.get(1)?.status).toBe("superseded");
    expect(JSON.parse(r.events.filter(e => e.stage === "memory_write").at(-1)!.detail_json)).toMatchObject({ id: 2, superseded: 1, duplicate: true });
  });
});

describe("提示段渲染（§7）", () => {
  it("空画像且无承诺时不渲染；画像全文 + 未完成承诺按截止升序、无截止的在后", async () => {
    const r = rig();
    expect(await r.service.render("owner")).toBeUndefined();
    expect(await r.service.render("shared")).toBeUndefined();
    await r.service.tool(ownerTurn(), "mem_remember", { text: "有空整理相册", kind: "commitment" });
    await r.service.tool(ownerTurn(), "mem_remember", { text: "周四前把周报模板改好发给他。", kind: "commitment", due_at: "2026-10-30" });
    await r.service.tool(ownerTurn(), "mem_remember", { text: "喜欢简短回复", kind: "preference" });
    expect(await r.service.render("owner")).toBe('<memory ns="owner" profile_revision="none">\n未完成的承诺：\n- #2 (截止 2026-10-30) 周四前把周报模板改好发给他。\n- #1 有空整理相册\n</memory>');
    const { revision } = await r.profiles.write("owner", "称呼：老王\n职业：工程师\n\n", PROFILE_NONE);
    const text = await renderMemorySection(r, "owner");
    expect(text).toBe(`<memory ns="owner" profile_revision="${revision}">\n称呼：老王\n职业：工程师\n\n未完成的承诺：\n- #2 (截止 2026-10-30) 周四前把周报模板改好发给他。\n- #1 有空整理相册\n</memory>`);
    // 内容不变时逐字不变（pi 不重发、codex 不重写）
    expect(await r.service.render("owner")).toBe(text);
    await r.service.tool(ownerTurn(), "mem_update", { id: 2, done_at: "2026-10-29" });
    await r.service.tool(ownerTurn(), "mem_forget", { id: 1, reason: "不做了" });
    expect(await r.service.render("owner")).toBe(`<memory ns="owner" profile_revision="${revision}">\n称呼：老王\n职业：工程师\n</memory>`);
    expect(await r.service.render("group:7")).toBeUndefined();
  });
});
