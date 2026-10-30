import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it } from "vitest";
import worker from "../src/index";
import { DEFAULT_SCHEDULE_OPTIONS, nextFireAt } from "../src/schedule/model";
import { SCHEDULE_IMPORT_MAX_BYTES } from "../src/schedule/import";

afterEach(reset);
const directory = () => env.SCHEDULE.getByName("main");
const now = Date.now(), yesterday = now - 86400_000;
const id = "11111111-1111-4111-8111-111111111111";
function fixture(taskId = id) {
  return { id: taskId, revision: 2, name: "每日早报", prompt: "读取新闻后发送", conversation: "group:200000001",
    rule: { kind: "rrule", rrule: "FREQ=DAILY;BYHOUR=8;BYMINUTE=30;BYSECOND=0", dtstart: yesterday - 86400_000 },
    mode: "thread", options: DEFAULT_SCHEDULE_OPTIONS, created_by: "qq:10000001", created_at: yesterday - 86400_000,
    updated_at: yesterday, next_fire_at: yesterday, failures: 0, fire_count: 7, status: "active",
    runs: [{ fire_key: taskId + "@" + yesterday, fire_at: yesterday, status: "sent", sent: 1, ended_at: yesterday, note: "已发" }] };
}
const alarm = () => runInDurableObject(directory(), (_instance, state) => state.storage.getAlarm());

it("previews without writes, preserves history and paused/completed states, schedules only future fires, and retries without overwriting edits", async () => {
  const active = fixture(), complete = { ...fixture("22222222-2222-4222-8222-222222222222"),
    name: "已完成提醒", status: "completed", rule: { kind: "at", at: yesterday }, next_fire_at: null };
  const paused = { ...fixture("33333333-3333-4333-8333-333333333333"), status: "paused", pause_reason: "manual", next_fire_at: null };
  const payload = { dryRun: true, schedules: [active, complete, paused] };
  expect(await directory().importSchedules(payload)).toMatchObject({ dryRun: true, imported: 0, skipped: 0,
    items: [{ id, action: "import" }, { status: "completed", next_fire_at: null }, { status: "paused", next_fire_at: null }] });
  expect(await directory().list()).toEqual([]);
  expect(await alarm()).toBeNull();
  expect(await directory().importSchedules({ ...payload, dryRun: false })).toMatchObject({ imported: 3, skipped: 0 });
  const list = await directory().list(), imported = list.find(s => s.id === id)!;
  const { fire_count: _count, ...expected } = active;
  expect(imported).toMatchObject({ ...expected, next_fire_at: expect.any(Number) });
  expect(imported.next_fire_at).toBe(nextFireAt(imported.rule, now));
  expect(imported.next_fire_at).toBeGreaterThan(now);
  expect(await alarm()).toBe(imported.next_fire_at);
  expect(await runInDurableObject(directory(), (_instance, state) => state.storage.sql.exec<{ fire_count: number }>("SELECT fire_count FROM schedules WHERE id = ?", id).one().fire_count)).toBe(7);
  await directory().setStatus(id, "paused", "manual", "admin");
  await directory().update(id, { prompt: "云端的新提示词" }, "admin");
  expect(await directory().importSchedules({ ...payload, dryRun: false })).toMatchObject({ imported: 0, skipped: 3 });
  expect((await directory().list()).find(s => s.id === id)).toMatchObject({ status: "paused", prompt: "云端的新提示词", runs: active.runs });
  expect(await alarm()).toBeNull();
});

it("rejects conflicts, duplicate IDs, in-flight runs, foreign fire keys and invalid rules without partial writes or resurrecting deleted imports", async () => {
  const first = fixture(), second = fixture("22222222-2222-4222-8222-222222222222");
  for (const schedules of [[first, first], [first, { ...second, runs: [{ ...second.runs[0], status: "running" }] }],
    [first, { ...second, runs: first.runs }], [first, { ...second, rule: { kind: "rrule", rrule: "FREQ=SECONDLY", dtstart: yesterday } }]]) {
    expect(await directory().importSchedules({ dryRun: false, schedules })).toEqual({ error: "invalid_import" });
    expect(await directory().list()).toEqual([]);
  }
  await directory().importSchedules({ dryRun: false, schedules: [first] });
  expect(await directory().importSchedules({ dryRun: false, schedules: [second, { ...first, prompt: "不同快照" }] })).toEqual({ error: "schedule_conflict" });
  expect(await directory().list()).toHaveLength(1);
  await directory().remove(id, "admin");
  expect(await directory().importSchedules({ dryRun: false, schedules: [first] })).toEqual({ error: "schedule_conflict" });
  expect(await directory().list()).toEqual([]);
});

it("authenticates the import route, bounds payloads, and returns conflict status", async () => {
  const call = (body: string, token = "migration-test") => worker.fetch(new Request("https://test/admin/schedules/import", {
    method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body,
  }), { ...env, ADMIN_TOKEN: "migration-test" });
  const payload = { dryRun: false, schedules: [fixture()] };
  expect((await call(JSON.stringify(payload), "wrong")).status).toBe(401);
  expect((await call("!")).status).toBe(400);
  expect((await call(" ".repeat(SCHEDULE_IMPORT_MAX_BYTES + 1))).status).toBe(413);
  expect((await call(JSON.stringify(payload))).status).toBe(200);
  expect((await call(JSON.stringify({ ...payload, schedules: [{ ...fixture(), name: "冲突" }] }))).status).toBe(409);
});
