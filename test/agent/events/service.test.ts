import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { eventInputKey } from "../../../src/agent/events/service.js";
import { EventSourceError, type EventSource } from "../../../src/agent/events/types.js";
import { eventRig, mail, START } from "./fixture.js";

const rigs: Awaited<ReturnType<typeof eventRig>>[] = [];
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(START); });
afterEach(async () => { for (const r of rigs.splice(0)) await r.close(); vi.useRealTimers(); });
async function rig(source?: EventSource) { const r = await eventRig(source); rigs.push(r); return r; }

it("过滤、合并与跨重启去重；trace 不含邮件资料", async () => {
  const r = await rig(); await r.settings({ mergeWindowS: 60 });
  await r.service.ingest("gmail", [mail("a"), mail("spam", { labels: ["INBOX", "CATEGORY_PROMOTIONS"] })]);
  await r.service.ingest("gmail", [mail("a"), mail("b"), mail("c")]);
  expect(r.insert).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(60_000);
  await vi.waitFor(() => expect(r.deliver).toHaveBeenCalledTimes(1));
  expect(r.insert.mock.calls[0][0]).toMatchObject({ owner: "1", count: 3, source: "gmail" });
  expect((await r.state()).stats.counts24h).toMatchObject({ delivered: 1, suppressed: 1, deduped: 1 });
  await r.restart();
  await r.service.ingest("gmail", [mail("b")]);
  expect((await r.state()).stats.counts24h.deduped).toBe(2);
  expect(await r.service.recentRuns()).toHaveLength(1);
  expect(JSON.stringify(r.event.mock.calls)).not.toMatch(/私密/);
  expect(r.event).toHaveBeenCalledWith("@events", "event_received", { detail: expect.objectContaining({ decision: "suppressed" }) });
});

it("每小时预算溢出留作下一条的未展开数", async () => {
  const r = await rig(); await r.settings({ mergeWindowS: 0, budgetPerHour: 2 });
  for (const id of ["a", "b", "c"]) await r.service.ingest("gmail", [mail(id)]);
  expect(r.deliver).toHaveBeenCalledTimes(2); expect((await r.state()).extraCount).toBe(1);
  vi.setSystemTime(START + 3_600_000);
  await r.service.ingest("gmail", [mail("d")]);
  expect(r.insert.mock.calls.at(-1)?.[0]).toMatchObject({ count: 2, text: expect.stringContaining("[另有 1 件未展开]") });
  await r.service.ingest("gmail", [mail("c")]);
  expect(r.deliver).toHaveBeenCalledTimes(3);
});

it("插入失败游标不推进，重启恢复持久积压；分页 more 最多五次，reset 不投旧信", async () => {
  const poll = vi.fn<NonNullable<EventSource["poll"]>>().mockResolvedValue({ cursor: "20", events: [mail("a")], more: false });
  const r = await rig({ id: "gmail", poll }); await r.settings({ mergeWindowS: 0 });
  r.insert.mockImplementationOnce(() => { throw new Error("数据库暂不可写"); });
  await expect(r.service.pollNow("gmail")).rejects.toThrow("事件轮询失败");
  expect((await r.state()).cursor).toBeNull(); expect((await r.state()).held).toHaveLength(1);
  await r.restart();
  expect((await r.state()).cursor).toBe("20"); expect(r.deliver).toHaveBeenCalled();
  poll.mockResolvedValue({ cursor: "30", events: [mail("old")], reset: true, more: true });
  await r.service.pollNow("gmail"); expect((await r.state()).cursor).toBe("30");
  expect(r.records.has(eventInputKey("gmail", "old"))).toBe(false);
  poll.mockClear().mockResolvedValue({ cursor: "40", events: [], more: true });
  await r.service.pollNow("gmail"); expect(poll).toHaveBeenCalledTimes(5);
});

it("轮询失败三次仅降级，成功恢复；正在轮询时不叠加，停止会中止", async () => {
  const poll = vi.fn<NonNullable<EventSource["poll"]>>().mockRejectedValue(new EventSourceError("auth"));
  const r = await rig({ id: "gmail", poll }); await r.settings({});
  for (let i = 0; i < 3; i++) await expect(r.service.pollNow("gmail")).rejects.toThrow();
  expect(await r.state()).toMatchObject({ enabled: true, stats: { degraded: true, consecutivePollFailures: 3 } });
  poll.mockResolvedValue({ cursor: "50", events: [] }); await r.service.pollNow("gmail");
  expect((await r.state()).stats.degraded).toBe(false);
  let signal: AbortSignal | undefined;
  poll.mockImplementation(async (_cursor, _limit, incoming) => { signal = incoming; return new Promise(() => {}); });
  const first = r.service.pollNow("gmail"); expect(r.service.pollNow("gmail")).toBe(first);
  await vi.waitFor(() => expect(signal).toBeDefined());
  await r.service.stop(); await first; expect(signal?.aborted).toBe(true);
});

it("单次轮询 30 秒超时并记一次失败", async () => {
  const r = await rig({ id: "gmail", poll: () => new Promise(() => {}) });
  const done = expect(r.service.pollNow("gmail")).rejects.toThrow("事件轮询失败");
  await vi.advanceTimersByTimeAsync(30_001); await done;
  expect((await r.state()).stats.consecutivePollFailures).toBe(1);
});

it("回合结算幂等，连续三次失败暂停；恢复不丢积压", async () => {
  const r = await rig(); await r.settings({ mergeWindowS: 0 });
  await r.service.ingest("gmail", [mail("silent")]);
  await r.service.finish(eventInputKey("gmail", "silent"), { status: "completed" });
  for (const id of ["x", "y", "z"]) {
    await r.service.ingest("gmail", [mail(id)]);
    await r.service.finish(eventInputKey("gmail", id), { status: "failed" });
  }
  await r.service.finish(eventInputKey("gmail", "z"), { status: "failed" });
  expect(await r.state()).toMatchObject({ enabled: false, stats: { pausedReason: "连续 3 次失败", counts24h: { silent: 1, failed: 3 } } });
  await r.service.ingest("gmail", [mail("paused")]); expect((await r.state()).held).toHaveLength(1);
  await r.service.resume("gmail"); expect((await r.state()).held).toHaveLength(0);
  expect(r.event).toHaveBeenCalledWith("@events", "event_source_state", { detail: { source: "gmail", state: "paused", reason: "连续 3 次失败" } });
});

it("跨午夜安静时段持久积压，结束后再投递", async () => {
  vi.setSystemTime(Date.parse("2026-10-27T15:30:00Z"));
  const r = await rig(); await r.settings({ mergeWindowS: 0, quietHours: { start: "23:00", end: "08:00" } });
  await r.service.ingest("gmail", [mail("quiet")]); await r.restart();
  expect(r.deliver).not.toHaveBeenCalled();
  vi.setSystemTime(Date.parse("2026-10-28T00:00:00Z"));
  await r.service.ingest("gmail", []); expect(r.deliver).toHaveBeenCalledTimes(1);
});

it("入站提交后投递暂失败，下一次检查重投同键，发送结果复用 Outbox 判定", async () => {
  const r = await rig(); await r.settings({ mergeWindowS: 0 });
  r.deliver.mockRejectedValueOnce(new Error("宿主暂不可用"));
  await expect(r.service.ingest("gmail", [mail("recover-delivery")])).rejects.toThrow();
  await r.service.ingest("gmail", []);
  expect(r.insert).toHaveBeenCalledTimes(1); expect(r.deliver).toHaveBeenCalledTimes(2);
  r.rows.push({ key: "send", thread_key: "owner", turn_id: "pi:event", input_key: eventInputKey("gmail", "recover-delivery"),
    system: false, message_type: "private", target_id: "1", mention_user_id: null, proactive: true, status: "sent", message_id: "1",
    text: "发送成功", text_sha256: "digest", images: [], files: [], created_at: new Date().toISOString(), sent_at: new Date().toISOString() });
  await r.service.finish(eventInputKey("gmail", "recover-delivery"), { status: "completed", turnId: "pi:event" });
  expect((await r.service.recentRuns())[0].result?.status).toBe("sent");
  expect((await r.state()).stats.counts24h.sent).toBe(1);
});

it("后端阻塞期间积压最多 200 件，丢弃最旧并发出告警事件", async () => {
  const r = await eventRig({ id: "gmail" }, async () => "codex"); rigs.push(r);
  await r.settings({ mergeWindowS: 0 });
  await r.service.ingest("gmail", Array.from({ length: 201 }, (_, i) => mail(String(i))));
  expect((await r.state()).held).toHaveLength(200);
  expect((await r.state()).held[0].externalId).toBe("1"); expect(r.insert).not.toHaveBeenCalled();
  expect(r.event).toHaveBeenCalledWith("@events", "event_source_state", { detail: { source: "gmail", state: "overflow", reason: "held_limit" } });
});
