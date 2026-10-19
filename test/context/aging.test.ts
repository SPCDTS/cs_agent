import { createModels, fauxAssistantMessage, fauxProvider, fauxText, type FauxResponseFactory } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AGING_LAST_RUN_KEY, msUntilNextRun, needsCatchUp, runAging, startAgingScheduler, type AgingOptions } from "../../src/context/aging.js";
import { ContextStore } from "../../src/context/store.js";
import type { InboundMessage } from "../../src/channel/types.js";
import { tmp } from "../agent/helpers.js";

const G = "group:200000001";
const DAY = 86400;
// 2026-10-21（周三）03:00 UTC；store 以 UTC 计日
const NOW = Date.UTC(2026, 9, 21, 3, 0, 0);
const dayStart = (y: number, m: number, d: number) => Math.floor(Date.UTC(y, m - 1, d) / 1000);

let store: ContextStore | undefined;
afterEach(() => store?.close());

let seq = 1;
function msg(time: number, text: string, group = "200000001"): InboundMessage {
  return {
    message_id: String(seq++), time, message_type: "group", user_id: "20001", group_id: group, self_id: "10001",
    nickname: "De", text, route_text: text, truncated: false, mentioned_self: false, images: [], segments: [{ type: "text", data: { text } }],
  };
}

function rig(responses: (FauxResponseFactory | ReturnType<typeof fauxAssistantMessage>)[]) {
  store = new ContextStore(tmp(), { tzOffsetSec: 0 });
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const inputs: string[] = [];
  faux.setResponses(
    responses.map((r) => (context) => {
      const u = context.messages.find((m) => m.role === "user")!;
      inputs.push(typeof u.content === "string" ? u.content : JSON.stringify(u.content));
      return typeof r === "function" ? r(context, undefined as never, undefined as never, undefined as never) : r;
    }) as FauxResponseFactory[],
  );
  const opts: AgingOptions = { store, models, model: faux.getModel(), rawDays: 30, summaryDays: 180, hour: 3, now: () => NOW };
  return { store, faux, opts, inputs };
}

describe("runAging", () => {
  it("摘要输入还原媒体占位，不携带路径", async () => {
    const r = rig([fauxAssistantMessage(fauxText("摘要"))]);
    for (let i = 0; i < 5; i++) r.store.ingest(msg(dayStart(2026, 10, 20) + i, "图 [image:/data/media/ab/secret.png]"));
    await runAging(r.opts);
    expect(r.inputs[0]).toContain("[image]");
    expect(r.inputs[0]).not.toContain("/data/media");
  });
  it("summarizes past days with ≥5 messages, skips small days and today, then is idempotent", async () => {
    const r = rig([fauxAssistantMessage(fauxText("10-20 摘要：讨论了比赛"))]);
    const d20 = dayStart(2026, 10, 20);
    for (let i = 0; i < 5; i++) r.store.ingest(msg(d20 + 3600 + i, `今晚有cs比赛吗 ${i}`));
    for (let i = 0; i < 4; i++) r.store.ingest(msg(dayStart(2026, 10, 19) + 3600 + i, `小 ${i}`));
    for (let i = 0; i < 6; i++) r.store.ingest(msg(dayStart(2026, 10, 21) + 60 + i, `今天 ${i}`));
    r.store.recordPending(G, "tk", d20 + 3700);
    r.store.completeReply("tk", { action: "generate_image", detail: "a dog", excerpt: "好了", image_count: 1, status: "已回复" });

    const rep = await runAging(r.opts);
    expect(rep).toMatchObject({ day_summaries: 1, week_summaries: 0, failed: 0 });
    expect(r.inputs[0]).toContain("今晚有cs比赛吗 0");
    expect(r.inputs[0]).toContain('[我] → 生图 prompt="a dog"');
    const hits = r.store.search({ kind: "scope", scope: G }, { query: "讨论了比赛", days: 30, limit: 10, now: NOW / 1000 });
    expect(hits).toEqual([expect.objectContaining({ kind: "summary", row: expect.objectContaining({ level: "day", period_start: d20, msg_count: 6 }) })]);
    expect(r.store.getMeta(AGING_LAST_RUN_KEY)).toBe(String(NOW / 1000));

    const again = await runAging(r.opts);
    expect(again.day_summaries).toBe(0);
    expect(r.faux.state.callCount).toBe(1);
  });

  it("folds a finished week of day summaries into one week summary, deleting the day rows", async () => {
    const r = rig([fauxAssistantMessage(fauxText("周摘要：一周的比赛讨论"))]);
    const mon = dayStart(2026, 10, 12); // 周一
    r.store.writeSummary({ scope: G, level: "day", period_start: mon, period_end: mon + DAY, text: "周一聊了比赛", msg_count: 6 });
    r.store.writeSummary({ scope: G, level: "day", period_start: mon + 2 * DAY, period_end: mon + 3 * DAY, text: "周三聊了战队", msg_count: 7 });
    // 本周（10-19 周一起）的日摘要不折叠
    r.store.writeSummary({ scope: G, level: "day", period_start: dayStart(2026, 10, 19), period_end: dayStart(2026, 10, 20), text: "本周一", msg_count: 5 });
    const rep = await runAging(r.opts);
    expect(rep.week_summaries).toBe(1);
    expect(r.inputs[0]).toContain("[日摘要 10-12] 周一聊了比赛");
    const items = r.store.search({ kind: "all" }, { query: "摘要", days: 60, limit: 10, now: NOW / 1000 });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "summary", row: { level: "week", period_start: mon, period_end: mon + 7 * DAY, msg_count: 13 } });
    expect(r.store.search({ kind: "all" }, { query: "本周一", days: 60, limit: 10, now: NOW / 1000 })).toHaveLength(1);
    // 折叠后的日子不会被重新做日摘要
    expect(r.store.pendingDaySummaries(NOW / 1000)).toEqual([]);
  });

  it("model failures are counted and skipped, never thrown; purge still runs", async () => {
    const r = rig([fauxAssistantMessage([], { stopReason: "error", errorMessage: "boom" })]);
    const d20 = dayStart(2026, 10, 20);
    for (let i = 0; i < 5; i++) r.store.ingest(msg(d20 + i, `x${i}`));
    r.store.ingest(msg(NOW / 1000 - 100 * DAY, "很久以前")); // 超过兜底上限 90 天
    const rep = await runAging(r.opts);
    expect(rep).toMatchObject({ day_summaries: 0, failed: 1, purged_messages: 1 });
    expect(r.store.pendingDaySummaries(NOW / 1000)).toHaveLength(1); // 下次再试
  });

  it("never purges raw messages of a day whose summary failed; purges them after a later successful retry", async () => {
    const r = rig([
      fauxAssistantMessage([], { stopReason: "error", errorMessage: "boom" }),
      fauxAssistantMessage(fauxText("补做的日摘要")),
    ]);
    const old = dayStart(2026, 9, 10); // 41 天前，超过 rawDays=30
    for (let i = 0; i < 5; i++) r.store.ingest(msg(old + 3600 + i, `旧日 ${i}`));
    const first = await runAging(r.opts);
    expect(first).toMatchObject({ day_summaries: 0, failed: 1, purged_messages: 0 });
    expect(r.store.messagesBetween(G, old, old + DAY)).toHaveLength(5);

    const second = await runAging(r.opts);
    expect(second).toMatchObject({ day_summaries: 1, failed: 0, purged_messages: 5 });
    expect(r.store.messagesBetween(G, old, old + DAY)).toHaveLength(0);
    expect(r.store.search({ kind: "all" }, { query: "补做", days: 365, limit: 10, now: NOW / 1000 })).toHaveLength(1);
  });

  it("purges uncovered raw messages once they pass HISTORY_RAW_HARD_MAX_DAYS", async () => {
    const r = rig([]);
    const nowSec = NOW / 1000;
    r.store.ingest(msg(nowSec - 40 * DAY, "未覆盖 40 天")); // 不足 5 条，永远不会有日摘要
    r.store.ingest(msg(nowSec - 91 * DAY, "未覆盖 91 天"));
    const rep = await runAging({ ...r.opts, rawHardMaxDays: 90 });
    expect(rep.purged_messages).toBe(1);
    expect(r.store.recent({ kind: "all" }, { limit: 10 }).map((m) => m.text)).toEqual(["未覆盖 40 天"]);
  });
});

describe("scheduler", () => {
  it("computes the next local run time", () => {
    const base = new Date(2026, 9, 21, 2, 30, 0).getTime();
    expect(msUntilNextRun(3, base)).toBe(30 * 60 * 1000);
    expect(msUntilNextRun(3, new Date(2026, 9, 21, 3, 0, 0).getTime())).toBe(24 * 3600 * 1000);
  });

  it("catches up at startup when last run is older than 24h, and not otherwise", async () => {
    const r = rig([]);
    expect(needsCatchUp(r.store, NOW)).toBe(true);
    const s = startAgingScheduler(r.opts);
    expect(s.running()).toBe(true);
    const rep = await s.runNow(); // 复用启动时触发的那次运行
    expect(s.running()).toBe(false);
    s.stop();
    expect(rep).toMatchObject({ day_summaries: 0, failed: 0 });
    expect(needsCatchUp(r.store, NOW + 3600_000)).toBe(false);
    expect(needsCatchUp(r.store, NOW + 25 * 3600_000)).toBe(true);
  });

  it("a crashing store never throws out of the scheduler", async () => {
    const r = rig([]);
    r.store.close();
    const s = startAgingScheduler(r.opts);
    expect(s.running()).toBe(false);
    const pending = s.runNow();
    expect(s.running()).toBe(true);
    expect(await pending).toBeUndefined();
    expect(s.running()).toBe(false);
    s.stop();
  });
});
