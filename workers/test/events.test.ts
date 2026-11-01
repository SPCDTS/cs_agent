import { env, reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventsDO } from "../src/events/do";
import { DEFAULT_SETTINGS, type SourceSettings } from "../src/events/model";
import { fakeGoogle, sql } from "./events-helpers";
import { action, connect } from "./helpers";

const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  vi.restoreAllMocks();
  await reset();
});
const events = () => env.EVENTS.getByName("main");
const settings = (patch: Partial<SourceSettings>) => events().putSettings("gmail", { ...DEFAULT_SETTINGS, ...patch });
type Held = { key: string; reason: string; received_at: number };
type Run = { input_key: string; keys_json: string; status: string };
const inbound = () => runInDurableObject(env.THREAD.getByName("owner"), (_instance, state) =>
  state.storage.sql.exec("SELECT 1 FROM sqlite_master WHERE name = 'inbound'").toArray().length
    ? state.storage.sql.exec<{ message_id: string; text: string; kind: string; status: string }>("SELECT message_id, text, kind, status FROM inbound ORDER BY rowid").toArray() : []);
const beijing = (offsetMinutes: number) => new Date(Date.now() + 8 * 3_600_000 + offsetMinutes * 60_000).toISOString().slice(11, 16);

describe("EventsDO Gmail polling", () => {
  it("starts from the current historyId without replaying the mailbox, and renews the watch when a topic is set", async () => {
    const google = fakeGoogle();
    google.addMail("old-1");
    await runInDurableObject(events(), async (_instance, state) => {
      await new EventsDO(state, { ...env, GMAIL_PUBSUB_TOPIC: "projects/proj-test/topics/gmail-push" }).poll("gmail");
    });
    expect(await sql("SELECT cursor FROM event_source")).toEqual([{ cursor: "101" }]);
    expect(await sql("SELECT key FROM event_held")).toEqual([]);
    expect(google.state.requests.some(line => line.includes("/history?"))).toBe(false);
    expect(google.state.watches).toBe(1);
    expect((await sql<{ expiration: number }>("SELECT expiration FROM gmail_watch"))[0]?.expiration).toBeGreaterThan(Date.now() + 6 * 86_400_000);
  });

  it("resets the cursor on 404, consumes history records whole across pages, and skips vanished messages", async () => {
    const google = fakeGoogle();
    await events().poll("gmail");
    await settings({ mergeWindowS: 600, budgetPerHour: 100 });
    for (let i = 0; i < 49; i++) google.addMail(`m${i}`);
    const split = google.state.historyId;
    google.addMail("x1", {}, false); google.addMail("x2", {}, false); google.addMail("x3", {}, false);
    google.state.history.push({ id: google.state.historyId, messages: ["x1", "x2", "x3"] });
    google.addMail("gone"); google.state.missing.add("gone");
    await events().notify("gmail");
    // 第二页从被拆开前的最后一条整记录继续，三封邮件的那条记录完整留到下一次。
    const starts = google.state.requests.filter(line => line.includes("/history?")).map(line => new URL(line.slice(4)).searchParams.get("startHistoryId"));
    expect(starts).toEqual(["100", String(split)]);
    expect(await sql<Held>("SELECT key FROM event_held")).toHaveLength(52);
    expect(await sql("SELECT cursor FROM event_source")).toEqual([{ cursor: String(google.state.historyId) }]);

    google.state.historyStatus = 404;
    google.addMail("lost");
    await events().notify("gmail");
    expect(await sql("SELECT cursor FROM event_source")).toEqual([{ cursor: String(google.state.historyId) }]);
    expect(await sql("SELECT key FROM event_held")).toHaveLength(52);
  });

  it("keeps at most 200 held events, dropping the oldest and alerting", async () => {
    const google = fakeGoogle();
    const { frames } = await connect(sockets);
    await events().poll("gmail");
    await settings({ mergeWindowS: 600 });
    for (let i = 0; i < 205; i++) google.addMail(`bulk${i}`);
    await events().notify("gmail");
    const held = await sql<{ event_json: string }>("SELECT event_json FROM event_held ORDER BY received_at, rowid");
    expect(held).toHaveLength(200);
    expect(JSON.parse(held[0]!.event_json).externalId).toBe("bulk5");
    expect((await action(frames, 0, "send_private_msg")).params.message?.[0]?.data.text).toContain("丢弃最旧的 5 件");
  });

  it("marks the source degraded after three failed polls and alerts the owner once", async () => {
    const google = fakeGoogle();
    const { frames, socket } = await connect(sockets);
    await events().poll("gmail");
    google.state.failGmail = true;
    for (let i = 0; i < 4; i++) await events().notify("gmail");
    expect(await sql("SELECT failures, degraded, last_error_code FROM event_source")).toEqual([{ failures: 4, degraded: 1, last_error_code: "upstream" }]);
    const alert = await action(frames, 0, "send_private_msg");
    expect(alert.params.user_id).toBe("10000001");
    expect(alert.params.message?.[0]?.data.text).toContain("连续 3 次拉取失败");
    socket.send(JSON.stringify({ status: "ok", retcode: 0, data: { message_id: 1 }, echo: alert.echo }));
    expect(frames.filter(frame => JSON.stringify(frame).includes("send_private_msg"))).toHaveLength(1);
    expect(JSON.stringify(await events().health())).toContain('"degraded":true');
  });
});

describe("EventsDO delivery pipeline", () => {
  it("merges events within the window into one owner input delivered by the alarm, and deduplicates repeats", async () => {
    const google = fakeGoogle();
    await events().poll("gmail");
    google.addMail("a"); google.addMail("promo", { labels: ["INBOX", "CATEGORY_PROMOTIONS"] }); google.addMail("b");
    await events().notify("gmail");
    expect(await sql<Held>("SELECT reason FROM event_held")).toEqual([{ reason: "merge" }, { reason: "merge" }]);
    expect(await inbound()).toEqual([]);
    const alarm = await runInDurableObject(events(), (_instance, state) => state.storage.getAlarm());
    expect(alarm).toBeGreaterThan(Date.now() + 50_000);

    await sql("UPDATE event_held SET received_at = received_at - 61000");
    expect(await runDurableObjectAlarm(events())).toBe(true);
    const runs = await sql<Run>("SELECT * FROM event_run");
    expect(runs).toHaveLength(1);
    expect(JSON.parse(runs[0]!.keys_json)).toHaveLength(2);
    const [row] = await inbound();
    expect(row).toMatchObject({ kind: "event", message_id: runs[0]!.input_key });
    expect(row?.text).toContain("[外部事件] gmail · 新邮件 2 件");
    expect(row?.text).toContain("ref=a · Alice <alice@example.test> · 主题：主题 a");
    expect(row?.text).not.toContain("promo");
    expect(await sql("SELECT key FROM event_held")).toEqual([]);
    await vi.waitFor(async () => expect((await sql<Run>("SELECT status FROM event_run"))[0]?.status).toBe("silent"), { timeout: 10_000 });

    google.state.history.push({ id: ++google.state.historyId, messages: ["a"] });
    await events().notify("gmail");
    expect(await sql("SELECT key FROM event_held")).toEqual([]);
    expect(await sql("SELECT 1 FROM event_run")).toHaveLength(1);
  });

  it("holds events during quiet hours and delivers them on the alarm after the window ends", async () => {
    const google = fakeGoogle();
    await events().poll("gmail");
    await settings({ quietHours: { start: beijing(-60), end: beijing(60) } });
    google.addMail("night");
    await events().notify("gmail");
    expect(await sql<Held>("SELECT reason FROM event_held")).toEqual([{ reason: "quiet" }]);
    const alarm = await runInDurableObject(events(), (_instance, state) => state.storage.getAlarm());
    expect(alarm).toBeGreaterThan(Date.now() + 58 * 60_000);
    expect(alarm).toBeLessThanOrEqual(Date.now() + 60 * 60_000);

    await sql("UPDATE event_source SET settings_json = ?", JSON.stringify({ ...DEFAULT_SETTINGS, quietHours: { start: beijing(-120), end: beijing(-60) } }));
    await sql("UPDATE event_held SET received_at = received_at - 61000");
    await runDurableObjectAlarm(events());
    expect(await sql("SELECT key FROM event_held")).toEqual([]);
    expect((await inbound())[0]?.text).toContain("主题：主题 night");
    // 投递返回时 Thread 仍在后台结算，等它完成后才能重置存储，避免串入下一用例。
    await vi.waitFor(async () => expect(await sql("SELECT 1 FROM event_run WHERE status = 'queued'")).toEqual([]), { timeout: 10_000 });
  });

  it("folds events over the hourly budget into the next input as an unexpanded count", async () => {
    const google = fakeGoogle();
    await events().poll("gmail");
    await settings({ mergeWindowS: 0, budgetPerHour: 1 });
    google.addMail("first");
    await events().notify("gmail");
    google.addMail("over-1"); google.addMail("over-2");
    await events().notify("gmail");
    expect(await sql<Held>("SELECT reason FROM event_held")).toEqual([{ reason: "budget" }, { reason: "budget" }]);
    expect(await inbound()).toHaveLength(1);

    await sql("UPDATE event_run SET delivered_at = delivered_at - 3600001");
    google.addMail("next");
    await events().notify("gmail");
    const rows = await inbound();
    expect(rows).toHaveLength(2);
    expect(rows[1]?.text).toContain("新邮件 1 件");
    expect(rows[1]?.text).toContain("主题：主题 next");
    expect(rows[1]?.text).not.toContain("over-1");
    expect(rows[1]?.text).toContain("[另有 2 件未展开]");
    const runs = await sql<Run>("SELECT keys_json FROM event_run ORDER BY rowid");
    expect(JSON.parse(runs[1]!.keys_json)).toHaveLength(3);
    // 投递返回时 Thread 仍在后台结算，等它完成后才能重置存储，避免串入下一用例。
    await vi.waitFor(async () => expect(await sql("SELECT 1 FROM event_run WHERE status = 'queued'")).toEqual([]), { timeout: 10_000 });
  });

  it("pauses the source after three failed event turns and alerts once", async () => {
    await sql("INSERT INTO event_run (input_key, source, keys_json, delivered_at, status) VALUES ('k1','gmail','[]',1,'queued'),('k2','gmail','[]',2,'queued'),('k3','gmail','[]',3,'queued')");
    await events().finishRun("k1", "failed");
    await events().finishRun("k2", "failed");
    expect(await sql("SELECT paused FROM event_source")).toEqual([{ paused: 0 }]);
    await events().finishRun("k3", "failed");
    expect(await sql("SELECT paused, pause_reason FROM event_source")).toEqual([{ paused: 1, pause_reason: "turn_failures" }]);
    expect(await sql("SELECT status FROM event_run ORDER BY rowid")).toEqual([{ status: "failed" }, { status: "failed" }, { status: "failed" }]);

    expect(await events().setPaused("gmail", false)).toBe(true);
    await sql("INSERT INTO event_run (input_key, source, keys_json, delivered_at, status) VALUES ('k4','gmail','[]',4,'queued')");
    await events().finishRun("k4", "failed");
    expect(await sql("SELECT paused FROM event_source")).toEqual([{ paused: 0 }]);
  });
});
