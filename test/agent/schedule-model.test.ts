import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_SCHEDULE_OPTIONS, missedFires, nextFireAt, parseCreate, parseUpdate, validateRule } from "../../src/agent/schedule/model.js";
import type { ScheduleRule } from "../../src/agent/schedule/types.js";

const now = Date.parse("2026-10-20T00:00:00Z");
const daily: ScheduleRule = { kind: "rrule", rrule: "FREQ=DAILY;BYHOUR=8;BYMINUTE=30;BYSECOND=0", dtstart: now };
const originalTZ = process.env.TZ;
afterEach(() => { if (originalTZ === undefined) delete process.env.TZ; else process.env.TZ = originalTZ; });

describe("定时规则", () => {
  it.each(["Asia/Shanghai", "UTC", "America/New_York"])("北京 08:30 → 00:30Z，与宿主时区 %s 无关", tz => {
    process.env.TZ = tz;
    const first = Date.parse("2026-10-20T00:30:00Z");
    expect(nextFireAt(daily, now)).toBe(first);
    expect(nextFireAt(daily, first - 1)).toBe(first);
    expect(nextFireAt(daily, first)).toBe(first + 86400_000);
  });

  it("DTSTART 是真实毫秒时刻；周规则、跨年与默认时分秒使用北京墙钟", () => {
    const start = Date.parse("2026-12-31T16:45:12Z");
    const rule: ScheduleRule = { kind: "rrule", dtstart: start, rrule: "FREQ=WEEKLY;BYDAY=FR" };
    expect(nextFireAt(rule, start - 1)).toBe(start);
    expect(nextFireAt(rule, start)).toBe(start + 7 * 86400_000);
  });

  it("COUNT / UNTIL 到期，UNTIL 的 UTC 边界包含末次", () => {
    const first = Date.parse("2026-10-20T00:30:00Z");
    expect(nextFireAt({ ...daily, rrule: daily.rrule + ";COUNT=1" }, first)).toBeNull();
    const until: ScheduleRule = { ...daily, rrule: daily.rrule + ";UNTIL=20261021T003000Z" };
    expect(nextFireAt(until, first)).toBe(first + 86400_000);
    expect(nextFireAt(until, first + 86400_000)).toBeNull();
    expect(missedFires(until, first, first + 7 * 86400_000)).toBe(2);
  });

  it("一次性必须在未来；相等不再触发", () => {
    const rule: ScheduleRule = { kind: "at", at: now + 1 };
    expect(validateRule(rule, now, true)).toBe(now + 1);
    expect(nextFireAt(rule, now + 1)).toBeNull();
    expect(() => validateRule(rule, now + 1, true)).toThrow("未来");
  });

  it.each([[true, 4, false], [true, 5, true], [false, 29, false], [false, 30, true]] as const)(
    "owner=%s、间隔 %s 分钟：允许=%s", (owner, interval, valid) => {
      const rule: ScheduleRule = { kind: "rrule", dtstart: now, rrule: `FREQ=MINUTELY;INTERVAL=${interval}` };
      if (valid) expect(validateRule(rule, now, owner)).toBe(now + interval * 60_000);
      else expect(() => validateRule(rule, now, owner)).toThrow("间隔");
    },
  );

  it("根据连续触发检查 BYMINUTE，而非只检查 FREQ", () => {
    expect(() => validateRule({ ...daily, rrule: "FREQ=DAILY;BYHOUR=8;BYMINUTE=1,2" }, now, true)).toThrow("间隔");
  });

  it.each(["", "FREQ=MINUTELY;INTERVAL=0", "FREQ=DAILY;COUNT=0", "FREQ=DAILY;BYHOUR=25",
    "FREQ=DAILY;BYMINUTE=60", "FREQ=DAILY;BYSECOND=-1", "FREQ=MONTHLY;BYMONTHDAY=0",
    "FREQ=DAILY;BYDAY=54MO", "FREQ=DAILY;BYDAY=0MO", "FREQ=BOGUS", "BYHOUR=8",
    "FREQ=DAILY;FREQ=WEEKLY", "FREQ=DAILY;UNTIL=20261020", "FREQ=DAILY;UNTIL=20260230T003000Z",
    "DTSTART;TZID=UTC:20261020T080000\nRRULE:FREQ=DAILY"])(
    "拒绝非法规则 %s", rrule => expect(() => validateRule({ ...daily, rrule }, now, true)).toThrow(),
  );

  it("RRULE 秒精度向上对齐，不早于包含毫秒的 DTSTART", () => {
    expect(nextFireAt({ kind: "rrule", rrule: "FREQ=DAILY", dtstart: now + 500 }, now)).toBe(now + 1000);
  });

  it("字段、会话、模式、选项与不可变字段校验", () => {
    const input = { name: "日报", prompt: "总结", conversation: "owner", rule: daily };
    expect(parseCreate(input).name).toBe("日报");
    expect(DEFAULT_SCHEDULE_OPTIONS).toEqual({ stale_after_ms: 600_000, timeout_ms: 300_000 });
    for (const patch of [
      { name: "" }, { name: "a".repeat(65) }, { prompt: "" }, { prompt: "a".repeat(8001) },
      { conversation: "group:x" }, { conversation: "private:0" }, { conversation: "qq:group:1" },
      { mode: "fork" }, { options: { timeout_ms: 900_001 } }, { options: { timeout_ms: 0 } },
      { options: { stale_after_ms: -1 } }, { created_by: "qq:1" },
    ]) expect(() => parseCreate({ ...input, ...patch })).toThrow();
    expect(parseCreate({ ...input, conversation: "group:123", options: { timeout_ms: 900_000 } }).options?.timeout_ms).toBe(900_000);
    expect(() => parseUpdate({ conversation: "private:1" })).toThrow();
    expect(() => parseUpdate({ revision: 10 })).toThrow();
  });
});
