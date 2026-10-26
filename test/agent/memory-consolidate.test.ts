import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryStore } from "../../src/context/memory/store.js";
import { ProfileStore } from "../../src/context/memory/profile.js";
import { CONSOLIDATE_CONFLICT_PROMPT, MemoryConsolidator, type MemoryConsolidatorOptions } from "../../src/agent/memory/consolidate.js";
import type { ExtractComplete } from "../../src/agent/memory/extractor.js";
import type { MemoryInput } from "../../src/context/memory/types.js";
import { Trace, type ObsEvent } from "../../src/shared/trace.js";
import { tmp } from "./helpers.js";

const clean: (() => void)[] = [];
afterEach(() => { for (const fn of clean.splice(0)) fn(); });

const DAY = 86400;
/** 2026-10-26 12:00 北京时间 */
const NOW = Date.UTC(2026, 9, 26, 4);

function rig(o: { complete?: ExtractComplete; messages?: Set<string>; enabled?: boolean; retentionDays?: number } = {}) {
  const dir = tmp("cs-memory-consolidate-");
  const clock = { sec: Math.floor(NOW / 1000) };
  const store = new MemoryStore(dir, () => clock.sec);
  clean.push(() => store.close());
  const profiles = new ProfileStore(dir);
  const events: ObsEvent[] = [];
  let n = 0;
  const trace = new Trace({ append: e => { const event = { id: ++n, ...e, detail_json: JSON.stringify(e.detail ?? {}) } as ObsEvent; events.push(event); return event; } });
  const messages = o.messages ?? new Set<string>();
  const complete = o.complete ? vi.fn(o.complete) : undefined;
  const opts: MemoryConsolidatorOptions = {
    store, profiles, trace, model: "deepseek/deepseek-flash", timeoutMs: 1000, now: () => clock.sec * 1000,
    rawDaysFor: () => o.retentionDays ?? 30, messageExists: (scope, id) => messages.has(`${scope}#${id}`),
    enabled: () => o.enabled ?? true, ...(complete ? { complete } : {}),
  };
  const c = new MemoryConsolidator(opts);
  /** 在某个时间写一条（created_at 取当时的时钟） */
  const add = (input: Partial<MemoryInput> & { text: string }, at = clock.sec) => {
    const saved = clock.sec; clock.sec = at;
    const row = store.remember({ ns: "owner", kind: "fact", author: "extractor", ...input }).row;
    clock.sec = saved; return row;
  };
  const batchEvents = () => events.filter(e => e.stage === "memory_consolidate").map(e => JSON.parse(e.detail_json) as Record<string, unknown>);
  return { store, profiles, c, add, clock, events, batchEvents, complete, messages };
}

describe("夜间整理", () => {
  it("精确去重：同 hash 的 active 只留最早的，后来的标 superseded 并建链，版本 by 为 consolidate:<batch_id>", async () => {
    const r = rig();
    const first = r.add({ text: "住在上海浦东" });
    const second = r.add({ text: "住在杭州" });
    // 恢复被遗忘的同正文条目是重复 active 的真实来源：mem_update 改正文或面板恢复
    r.store.update(second.id, { text: "住在上海浦东。" }, "qq:1");
    const report = (await r.c.run())!;
    expect(report.batches[0]).toMatchObject({ ns: "owner", dedup: 1 });
    expect(r.store.get(first.id)!.status).toBe("active");
    expect(r.store.get(second.id)!.status).toBe("superseded");
    expect(r.store.links(second.id)).toEqual([expect.objectContaining({ from_id: first.id, to_id: second.id, rel: "supersedes" })]);
    expect(r.store.versions(second.id).at(-1)!.by).toBe(`consolidate:${report.batches[0]!.batch_id}`);
  });

  describe("近似冲突", () => {
    const pair = (r: ReturnType<typeof rig>) => ({
      a: r.add({ text: "每天早上九点到公司上班", subject: "self" }),
      b: r.add({ text: "每天早上十点到公司上班", subject: "self" }),
    });

    it("同 subject、重叠率高的抽取条目成对送审；a_supersedes_b 取代 B，提示词受管且条目作为数据", async () => {
      const r = rig({ complete: async () => '[{"pair":1,"verdict":"b_supersedes_a"}]' });
      const { a, b } = pair(r);
      r.add({ text: "养了一只猫叫团子", subject: "self" });
      const report = (await r.c.run())!;
      expect(report.batches[0]!.conflicts).toMatchObject({ pairs: 1, superseded: 1 });
      expect(r.store.get(a.id)!.status).toBe("superseded");
      expect(r.store.get(b.id)!.status).toBe("active");
      const prompt = r.complete!.mock.calls[0]![0];
      expect(prompt.startsWith(CONSOLIDATE_CONFLICT_PROMPT)).toBe(true);
      expect(prompt).toContain("<数据>");
      expect(prompt).not.toContain("团子");
    });

    it("keep 与 coexist 不改状态，coexist 建 related；判过且未改动的对下次不再送审，改了正文后重新送审", async () => {
      const r = rig({ complete: async () => '[{"pair":1,"verdict":"coexist"}]' });
      const { a, b } = pair(r);
      await r.c.run();
      expect([r.store.get(a.id)!.status, r.store.get(b.id)!.status]).toEqual(["active", "active"]);
      expect(r.store.links(a.id)).toEqual([expect.objectContaining({ from_id: a.id, to_id: b.id, rel: "related" })]);
      r.clock.sec += DAY;
      const again = (await r.c.run())!;
      expect(again.batches[0]!.conflicts.pairs).toBe(0);
      expect(r.complete).toHaveBeenCalledTimes(1);
      // 一条经 mem_update 改了正文：指纹变了，下一次重新送审
      r.clock.sec += DAY;
      r.store.update(b.id, { text: "每天早上十点半到公司上班" }, "qq:1");
      r.clock.sec += DAY;
      expect((await r.c.run())!.batches[0]!.conflicts.pairs).toBe(1);
      expect(r.complete).toHaveBeenCalledTimes(2);
    });

    it("显式写入的条目不被整理取代（判为过时也只算 keep）", async () => {
      const r = rig({ complete: async () => '[{"pair":1,"verdict":"b_supersedes_a"}]' });
      const a = r.add({ text: "每天早上九点到公司上班", subject: "self", author: "qq:1" });
      r.add({ text: "每天早上十点到公司上班", subject: "self" });
      const report = (await r.c.run())!;
      expect(report.batches[0]!.conflicts).toMatchObject({ superseded: 0, protected: 1 });
      expect(r.store.get(a.id)!.status).toBe("active");
    });

    it("模型失败或输出形状不对时整批跳过，不改任何条目，其余步骤照常", async () => {
      for (const complete of [async () => { throw new Error("down"); }, async () => '{"pair":1}', async () => '[{"pair":2,"verdict":"keep"}]'] as ExtractComplete[]) {
        const r = rig({ complete });
        const { a, b } = pair(r);
        const old = r.add({ text: "去年夏天去了青岛", kind: "episode" }, Math.floor(NOW / 1000) - 200 * DAY);
        const report = (await r.c.run())!;
        expect(report.batches[0]!.conflicts.skipped).toMatch(/model_error|invalid_json/);
        expect([r.store.get(a.id)!.status, r.store.get(b.id)!.status]).toEqual(["active", "active"]);
        expect(r.store.get(old.id)!.status).toBe("retired");
      }
    });
  });

  it("孤立：来源消息已撤回的抽取条目标 orphaned；显式写入与来源尚存的不动", async () => {
    const r = rig();
    const gone = r.add({ text: "下周三去杭州出差", source_scope: "private:1", source_message_id: "m1" });
    const kept = r.add({ text: "女儿叫小满", source_scope: "private:1", source_message_id: "m2" });
    const explicit = r.add({ text: "回复不要用 Markdown", kind: "rule", author: "qq:1", source_scope: "private:1", source_message_id: "m3" });
    r.messages.add("private:1#m2");
    const report = (await r.c.run())!;
    expect(report.batches[0]!.orphaned).toBe(1);
    expect(r.store.get(gone.id)!.status).toBe("orphaned");
    expect(r.store.get(kept.id)!.status).toBe("active");
    expect(r.store.get(explicit.id)!.status).toBe("active");
  });

  it("孤立：早于原文保留期的来源可能是被清理而不是撤回，不检查；来源会话永不清理（保留天数 0）时不限时间", async () => {
    const r = rig({ retentionDays: 30 });
    const old = r.add({ text: "下周三去杭州出差", source_scope: "private:1", source_message_id: "m1" }, Math.floor(NOW / 1000) - 40 * DAY);
    await r.c.run();
    expect(r.store.get(old.id)!.status).toBe("active");

    const never = rig({ retentionDays: 0 });
    const gone = never.add({ text: "下周三去杭州出差", source_scope: "private:1", source_message_id: "m1" }, Math.floor(NOW / 1000) - 400 * DAY);
    expect((await never.c.run())!.batches[0]!.orphaned).toBe(1);
    expect(never.store.get(gone.id)!.status).toBe("orphaned");
  });

  it("降级：episode 超过 180 天未召回标 retired（未召回看创建时间、召回过看最近召回），恰好 180 天与其他种类不动", async () => {
    const r = rig();
    const now = Math.floor(NOW / 1000);
    const stale = r.add({ text: "去年夏天去了青岛", kind: "episode" }, now - 181 * DAY);
    const edge = r.add({ text: "前年冬天去了哈尔滨", kind: "episode" }, now - 180 * DAY);
    const recalled = r.add({ text: "大学毕业旅行去了云南", kind: "episode" }, now - 400 * DAY);
    r.clock.sec = now - 10 * DAY; r.store.touchRecall([recalled.id]); r.clock.sec = now;
    const fact = r.add({ text: "老家在成都" }, now - 400 * DAY);
    const report = (await r.c.run())!;
    expect(report.batches[0]!.retired).toBe(1);
    expect(r.store.get(stale.id)!.status).toBe("retired");
    expect([edge, recalled, fact].map(x => r.store.get(x.id)!.status)).toEqual(["active", "active", "active"]);
  });

  describe("画像提议", () => {
    const fill = (r: ReturnType<typeof rig>, count: number, from = 0) => {
      for (let i = from; i < from + count; i++) r.add({ text: `偏好第 ${i} 条：喝咖啡不加糖之类的习惯 ${i}`, kind: i % 2 ? "preference" : "rule" });
    };

    it("owner 的偏好与要求超过 30 条才生成；存为待确认、不写文件；同一 ns 只留一条 pending，没变化不重复生成", async () => {
      let n = 0;
      const r = rig({ complete: async prompt => prompt.startsWith(CONSOLIDATE_CONFLICT_PROMPT) ? "[]" : JSON.stringify({ profile: `称呼：主人（第 ${++n} 版）` }) });
      fill(r, 30);
      expect((await r.c.run())!.batches[0]!.proposal).toBe("below_threshold");
      fill(r, 1, 30);
      r.clock.sec += 10;
      expect((await r.c.run())!.batches[0]!.proposal).toBe("created");
      expect((await r.profiles.read("owner")).text).toBe("");
      r.clock.sec += 10;
      expect((await r.c.run())!.batches[0]!.proposal).toBe("unchanged");
      r.clock.sec += 10;
      r.add({ text: "周末不安排工作", kind: "rule" });
      r.clock.sec += 10;
      expect((await r.c.run())!.batches[0]!.proposal).toBe("created");
      const pending = r.store.proposals("pending");
      expect(pending).toHaveLength(1);
      expect(pending[0]!.text).toBe("称呼：主人（第 2 版）");
    });

    it("采纳以生成时的 revision 做 CAS：画像已被改过 → conflict，提议仍待确认；未改过则写入并标 accepted", async () => {
      const r = rig({ complete: async prompt => prompt.startsWith(CONSOLIDATE_CONFLICT_PROMPT) ? "[]" : '{"profile":"称呼：主人"}' });
      fill(r, 31);
      await r.c.run();
      const [p] = r.store.proposals();
      const { revision } = await r.profiles.write("owner", "手改过的画像", p!.based_on_revision);
      await expect(r.c.acceptProposal(p!.id)).rejects.toMatchObject({ code: "conflict" });
      expect(r.store.proposal(p!.id)!.status).toBe("pending");
      await r.c.rejectProposal(p!.id);
      expect(r.store.proposal(p!.id)!.status).toBe("rejected");
      // 新一轮基于当前画像生成，采纳成功
      r.clock.sec += 10; r.add({ text: "周末不安排工作", kind: "rule" }); r.clock.sec += 10;
      await r.c.run();
      const [q] = r.store.proposals();
      expect(q!.based_on_revision).toBe(revision);
      await r.c.acceptProposal(q!.id);
      expect((await r.profiles.read("owner")).text).toBe("称呼：主人");
      expect(r.store.proposal(q!.id)).toMatchObject({ status: "accepted" });
      await expect(r.c.acceptProposal(q!.id)).rejects.toMatchObject({ code: "conflict" });
    });
  });

  it("报告：每个批次一个 @memory / memory_consolidate 事件，带 batch_id、各步计数、用量与耗时；上次运行与报告存 memory_meta", async () => {
    const r = rig({ complete: async () => ({ text: '[{"pair":1,"verdict":"keep"}]', usage: { input: 120, output: 8 } }) });
    r.add({ text: "每天早上九点到公司上班", subject: "self" });
    r.add({ text: "每天早上十点到公司上班", subject: "self" });
    r.store.remember({ ns: "group:7", kind: "fact", text: "群主是老王", author: "qq:5" });
    expect(r.c.needsCatchUp()).toBe(true);
    const report = (await r.c.run())!;
    const events = r.batchEvents();
    expect(events.map(e => e.ns).sort()).toEqual(["group:7", "owner"]);
    expect(events.find(e => e.ns === "owner")).toMatchObject({ batch_id: expect.any(String), dedup: 0, orphaned: 0, retired: 0,
      conflicts: expect.objectContaining({ pairs: 1, keep: 1 }), usage: expect.objectContaining({ input_tokens: 120, output_tokens: 8 }), ms: expect.any(Number) });
    expect(r.c.status()).toMatchObject({ enabled: true, running: false, available: true, last_run: NOW, last_report: report });
    expect(r.c.needsCatchUp()).toBe(false);
  });

  it("开关关闭时不运行", async () => {
    const r = rig({ enabled: false });
    r.add({ text: "去年夏天去了青岛", kind: "episode" }, Math.floor(NOW / 1000) - 200 * DAY);
    expect(await r.c.run()).toBeUndefined();
    expect(r.c.trigger()).toBe("disabled");
    expect(r.batchEvents()).toEqual([]);
  });

  it("关闭时正在等模型：有界等待后中止，模型之后返回的结果不落库，也不记为完成", async () => {
    let resolve!: (v: string) => void;
    const r = rig({ complete: () => new Promise<string>(res => { resolve = res; }) });
    const a = r.add({ text: "每天早上九点到公司上班", subject: "self" });
    r.add({ text: "每天早上十点到公司上班", subject: "self" });
    const run = r.c.run();
    await vi.waitFor(() => expect(r.complete).toHaveBeenCalled());
    await r.c.close(20);
    resolve('[{"pair":1,"verdict":"b_supersedes_a"}]');
    expect((await run)?.status ?? "closed").toBe("closed");
    expect(r.store.get(a.id)!.status).toBe("active");
    expect(r.c.status().last_run).toBeNull();
  });
});

describe("整批回退", () => {
  it("批次仍在运行（模型未返回）时回退为 conflict", async () => {
    let resolve!: (v: string) => void;
    const r = rig({ complete: () => new Promise<string>(res => { resolve = res; }) });
    const dup = r.add({ text: "住在杭州" });
    r.add({ text: "住在上海浦东" });
    r.store.update(dup.id, { text: "住在上海浦东" }, "qq:1");
    r.add({ text: "每天早上九点到公司上班", subject: "self" });
    r.add({ text: "每天早上十点到公司上班", subject: "self" });
    const run = r.c.run();
    await vi.waitFor(() => expect(r.complete).toHaveBeenCalled());
    const [batch] = r.store.consolidateBatches();
    expect(() => r.c.rollback(batch!.batch_id)).toThrow(expect.objectContaining({ code: "conflict" }));
    resolve("[]");
    await run;
    expect(r.c.rollback(batch!.batch_id)).toEqual({ restored: 1, skipped: 0 });
  });

  it("按逆序恢复该批次改过条目的状态与 until，正文不动，写 rollback 版本、删本批建的取代链；再回退为 conflict", async () => {
    const r = rig();
    const now = Math.floor(NOW / 1000);
    const first = r.add({ text: "住在上海浦东" });
    const dup = r.add({ text: "住在杭州" });
    r.store.update(dup.id, { text: "住在上海浦东" }, "qq:1");
    const old = r.add({ text: "去年夏天去了青岛", kind: "episode" }, now - 200 * DAY);
    const report = (await r.c.run())!;
    const batch = report.batches[0]!.batch_id;
    expect(r.store.get(dup.id)).toMatchObject({ status: "superseded", until: now });
    expect(r.store.consolidateBatches()).toEqual([expect.objectContaining({ batch_id: batch, ns: "owner", changes: 2, rolled_back: false })]);
    r.clock.sec += 60;
    expect(r.c.rollback(batch)).toEqual({ restored: 2, skipped: 0 });
    expect(r.store.get(dup.id)).toMatchObject({ status: "active", until: null, text: "住在上海浦东" });
    expect(r.store.get(old.id)!.status).toBe("active");
    expect(r.store.get(first.id)!.status).toBe("active");
    expect(r.store.links(dup.id)).toEqual([]);
    expect(r.store.versions(dup.id).at(-1)).toMatchObject({ by: `rollback:${batch}`, reason: "rollback" });
    expect(r.store.consolidateBatches()[0]!.rolled_back).toBe(true);
    expect(() => r.c.rollback(batch)).toThrow(expect.objectContaining({ code: "conflict" }));
    expect(() => r.c.rollback("00000000-0000-0000-0000-000000000000")).toThrow(expect.objectContaining({ code: "not_found" }));
  });

  it("批次之后又被改过的条目跳过，不覆盖后来的变更", async () => {
    const r = rig();
    const old = r.add({ text: "去年夏天去了青岛", kind: "episode" }, Math.floor(NOW / 1000) - 200 * DAY);
    const batch = (await r.c.run())!.batches[0]!.batch_id;
    r.store.setStatus(old.id, "forgotten", "dashboard", "面板遗忘");
    expect(r.c.rollback(batch)).toEqual({ restored: 0, skipped: 1 });
    expect(r.store.get(old.id)!.status).toBe("forgotten");
  });
});
