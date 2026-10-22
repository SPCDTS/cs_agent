import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyEffort, heuristicEffort, resolveAutoEffort } from "../../src/agent/effort-router.js";
import { Trace, type LiveEvent } from "../../src/shared/trace.js";

const hints = { hasImages: false, hasQuote: false };
afterEach(() => vi.useRealTimers());

describe("auto 选档", () => {
  it.each(["你好", "谢谢！", "[来源] 群 1 · 用户\n[引用 #2] 用户: 为什么\n  早 上 好 "])("寒暄快路径：%s", text => {
    expect(heuristicEffort(text, hints)).toBe("low");
  });
  it.each(["仔细分析这段代码", "Please THINK HARD"])("深度请求快路径：%s", text => {
    expect(heuristicEffort(text, hints)).toBe("xhigh");
  });
  it.each(["", "你好？", "fn()", "这是一条超过十二字的普通解释请求"])("非寒暄不误走 low：%s", text => {
    expect(heuristicEffort(text, hints)).toBeUndefined();
  });
  it("图片和引用阻止短文本快路径", () => {
    expect(heuristicEffort("看看", { ...hints, hasImages: true })).toBeUndefined();
    expect(heuristicEffort("看看", { ...hints, hasQuote: true })).toBeUndefined();
  });
  it.each([["LOW", "low"], [" **Medium**。 ", "medium"], ['"HIGH"!', "high"], ["（XHIGH）", "xhigh"]])("分类输出大小写与标点：%s", async (output, expected) => {
    const complete = vi.fn(async () => output);
    const signal = new AbortController().signal;
    expect(await classifyEffort({ complete }, "解释一下", hints, signal)).toBe(expected);
    expect(complete).toHaveBeenCalledWith(expect.stringContaining("解释一下"), signal);
  });
  it.each(["high because code", "low/high", ""])("非法输出回退且不记录正文：%s", async output => {
    const events: LiveEvent[] = [], trace = new Trace(); trace.tap(e => events.push(e));
    expect(await resolveAutoEffort({ complete: async () => output, model: "classifier", trace },
      { ...hints, text: "请解释这份私密设计文档", key: "t1" }, "high")).toEqual({ effort: "high", source: "auto-fallback" });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ key: "t1", stage: "effort_route", status: "fallback",
      detail: { effort: "high", source: "auto-fallback", model: "classifier", ms: expect.any(Number) } });
    expect(JSON.stringify(events)).not.toContain("私密");
  });
  it("快路径不调用分类，成功事件记录 auto", async () => {
    const complete = vi.fn(), event = vi.fn();
    expect(await resolveAutoEffort({ complete, trace: { event } }, { ...hints, key: "fast", text: "你好" }, "high"))
      .toEqual({ effort: "low", source: "auto" });
    expect(complete).not.toHaveBeenCalled();
    expect(event).toHaveBeenCalledWith("fast", "effort_route", expect.objectContaining({ status: "ok" }));
  });
  it("超时取消调用；提供者忽略 signal 仍有界回退", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const result = resolveAutoEffort({ timeoutMs: 40, complete: async (_p, s) => { signal = s; return new Promise(() => {}); } },
      { ...hints, key: "slow", text: "如何调试" }, "medium");
    await vi.advanceTimersByTimeAsync(40);
    expect(await result).toEqual({ effort: "medium", source: "auto-fallback" });
    expect(signal?.aborted).toBe(true);
  });
  it("分类异常与禁用分类均保留配置中的 off/max", async () => {
    const msg = { ...hints, key: "fallback", text: "如何调试" };
    expect(await resolveAutoEffort({ complete: async () => { throw Error("unavailable"); } }, msg, "off"))
      .toEqual({ effort: "off", source: "auto-fallback" });
    expect(await resolveAutoEffort({}, msg, "max")).toEqual({ effort: "max", source: "auto-fallback" });
  });
});
