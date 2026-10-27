import { getSystemMessageText, type TranscriptContext } from "@earendil-works/pi-ai";
import type { ConversationId } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryStore } from "../../src/context/memory/store.js";
import { ProfileStore } from "../../src/context/memory/profile.js";
import { MemoryService } from "../../src/agent/memory/service.js";
import { MEMORY_RULE } from "../../src/agent/memory/tools.js";
import { tmp } from "./helpers.js";
import { call, context, reply, residentRig, type ResidentRig } from "./resident-fixture.js";

const clean: (() => void)[] = [];
afterEach(() => { for (const fn of clean.splice(0)) fn(); });

const systemText = (ctx: TranscriptContext) => ctx.messages.filter(m => m.role === "system")
  .map(m => getSystemMessageText(m as Parameters<typeof getSystemMessageText>[0])).join("\n");
const results = (ctx: TranscriptContext) => ctx.messages.filter(m => m.role === "toolResult")
  .map(m => ({ name: m.toolName, error: m.isError, text: JSON.stringify(m.content) }));

async function rig(steps: ((ctx: TranscriptContext) => ReturnType<typeof reply>)[]) {
  const dir = tmp("cs-pi-memory-");
  const store = new MemoryStore(dir);
  clean.push(() => store.close());
  const memory = new MemoryService({ store, profiles: new ProfileStore(dir), owners: ["1", "9"] });
  const queue = [...steps];
  const r = await residentRig({ memory, brain: ctx => (queue.shift() ?? (() => reply()))(ctx) });
  return { r, store, memory };
}
const visible = async (r: ResidentRig, key: string) => (await (await r.pi.harness.conversation((await r.pi.readThreadIds())[key]! as ConversationId, context))!
  .agent(context)).tools.map(t => t.name).filter(n => n.startsWith("mem_"));
const turn = async (r: ResidentRig, user: string, text: string, group: string | null) => { await r.say(user, text, group); await r.idle(); };

describe("pi：mem_* 工具按本轮权限注册，memory 段进入系统提示", () => {
  it("owner 私聊记下的条目进入 owner 会话的提示；群里看不到，群成员没有 mem_profile", async () => {
    const seen: TranscriptContext[] = [];
    const inspect = (ctx: TranscriptContext) => { seen.push(ctx); return reply(); };
    const { r, store } = await rig([
      () => call(["mem_remember", { text: "周四前把周报模板改好发给他。", kind: "commitment", due_at: "2026-10-30" }]), inspect,
      inspect,
      () => call(["mem_search", { query: "周报" }], ["mem_remember", { text: "家庭群每周五聚餐", kind: "fact" }]), inspect,
    ]);
    await turn(r, "1", "记一下：周四前把周报模板发他", null);
    expect(results(seen[0]!)).toEqual([expect.objectContaining({ name: "mem_remember", error: false, text: expect.stringContaining("已记住：#1 [commitment] (截止 2026-10-30)") })]);
    expect(store.get(1)).toMatchObject({ ns: "owner", author: "qq:1", source_scope: "private:1" });
    expect(await visible(r, "owner")).toEqual(["mem_search", "mem_remember", "mem_update", "mem_forget", "mem_profile"]);
    // 规则在每条系统消息的受管段里只出现一次；下一轮 memory 段带上未完成的承诺
    for (const m of seen[0]!.messages.filter(m => m.role === "system"))
      expect(getSystemMessageText(m as Parameters<typeof getSystemMessageText>[0]).split(MEMORY_RULE).length).toBeLessThanOrEqual(2);
    expect(systemText(seen[0]!)).toContain(MEMORY_RULE);
    await turn(r, "1", "还有什么没做", null);
    expect(systemText(seen[1]!)).toContain('<memory ns="owner" profile_revision="none">\n未完成的承诺：\n- #1 (截止 2026-10-30) 周四前把周报模板改好发给他。\n</memory>');
    // 群成员：读写本群，看不到 owner 的条目，也没有画像工具与 owner 的 memory 段
    await turn(r, "5", "群里查一下周报", "7");
    expect(results(seen[2]!)).toEqual([
      expect.objectContaining({ name: "mem_search", error: false, text: expect.stringContaining("没有找到匹配的记忆") }),
      expect.objectContaining({ name: "mem_remember", error: false }),
    ]);
    expect(store.get(2)).toMatchObject({ ns: "group:7", author: "qq:5" });
    expect(systemText(seen[2]!)).not.toContain("<memory");
    expect(await visible(r, "group:7")).toEqual(["mem_search", "mem_remember", "mem_update", "mem_forget"]);
  });

  it("没有确证身份的回合只注册读工具；直接调用写工具在服务端拒绝", async () => {
    const seen: TranscriptContext[] = [];
    const { r, memory } = await rig([() => call(["mem_search", {}]), ctx => { seen.push(ctx); return reply(); }]);
    await turn(r, "5", "看看记忆", "7");
    expect(results(seen[0]!)[0]).toMatchObject({ name: "mem_search", error: false });
    // 唤醒回合没有继承的人：可见集只剩读工具，服务端同样拒绝写
    const wake = { threadKey: "group:7", scope: "group:7", identity: { kind: "wake" as const }, inputs: [] };
    expect(memory.toolNames(wake)).toEqual(["mem_search"]);
    await expect(memory.tool(wake, "mem_remember", { text: "x", kind: "fact" })).rejects.toThrow("本轮身份未确证");
  });
});
