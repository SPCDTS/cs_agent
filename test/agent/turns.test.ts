import { describe, expect, it, vi } from "vitest";
import { BackendRouter, TurnMonitor, UndeliverableError, type BackendAdapter } from "../../src/agent/turns.js";
import { TURN_NOTICES } from "../../src/agent/replies.js";
import type { InboundRecord, TurnBinding } from "../../src/channel/types.js";
import type { InputRef, TurnEnded } from "../../src/agent/host/types.js";

const rec = (key: string, scope = "group:7"): InboundRecord => ({ key, kind: "user", seq: 1, scope, thread_key: scope, self_id: "2", user_id: "5",
  group_id: "7", message_type: "group", message_id: "m-" + key, nickname: "五", text: "正文 " + key, route_text: "", time: 1, images: [],
  attachments: [], created_at: "", state: "queued" });
const input = (key: string): InputRef => ({ inboundKey: key, kind: "user", sender: "5", seq: 1, at: 0 });

function adapter(name: string, overrides: Partial<BackendAdapter> = {}): BackendAdapter {
  return {
    startTurn: vi.fn(async () => ({ turnId: `${name}:1` })), steer: vi.fn(async () => "ok" as const),
    interrupt: vi.fn(async () => {}), recoverTurn: vi.fn(async () => "alive" as const), ...overrides,
  };
}

describe("BackendRouter", () => {
  it("按本轮首条输入的会话选择后端并冻结设置；插话与恢复按回合 id 前缀分派", async () => {
    const pi = adapter("pi"), codex = adapter("codex");
    const settings = vi.fn(async (scope: string) => ({ backend: scope === "group:7" ? "pi" as const : "codex" as const, codexReasoningEffort: "high" as const }));
    const router = new BackendRouter({ backends: { pi, codex }, settings, turns: { records: inputs => inputs.map(i => rec(i.inboundKey)) } });
    expect(await router.startTurn("group:7", [input("a"), input("b")], { kind: "user", sender: "5" })).toEqual({ turnId: "pi:1" });
    expect(settings).toHaveBeenCalledWith("group:7", expect.objectContaining({ ticket: "a", text: "正文 a\n正文 b" }));
    expect(pi.startTurn).toHaveBeenCalledWith("group:7", expect.any(Array), { kind: "user", sender: "5" }, expect.objectContaining({ backend: "pi" }));
    expect(await router.steer("group:7", "codex:9", input("c"))).toBe("ok");
    expect(codex.steer).toHaveBeenCalled();
    expect(await router.recoverTurn("group:7", "unknown:1")).toBe("lost");
    expect(await router.recoverTurn("group:7", "pi:3:4")).toBe("alive");
    await router.interrupt("group:7");
    expect(pi.interrupt).toHaveBeenCalled(); expect(codex.interrupt).toHaveBeenCalled();
  });

  it("后端不可用时在重试窗口内重试，超过窗口抛 UndeliverableError", async () => {
    let fail = 2;
    const pi = adapter("pi", { startTurn: vi.fn(async () => { if (fail-- > 0) throw new Error("暂不可用"); return { turnId: "pi:1" }; }) });
    const settings = async () => ({ backend: "pi" as const, codexReasoningEffort: "high" as const });
    const turns = { records: (inputs: readonly Pick<InputRef, "inboundKey">[]) => inputs.map(i => rec(i.inboundKey)) };
    const router = new BackendRouter({ backends: { pi }, settings, turns, retryMs: 1000, retryDelayMs: 1 });
    expect(await router.startTurn("group:7", [input("a")], { kind: "user", sender: "5" })).toEqual({ turnId: "pi:1" });
    const down = new BackendRouter({ backends: { pi: adapter("pi", { startTurn: async () => { throw new Error("挂了"); } }) }, settings, turns, retryMs: 20, retryDelayMs: 5 });
    await expect(down.startTurn("group:7", [input("a")], { kind: "user", sender: "5" })).rejects.toBeInstanceOf(UndeliverableError);
  });

  it("重试开轮前复核准入：授权在两次尝试之间撤销 → 返回 denied，不再开轮；后端只收到不含 admit 的回合信息", async () => {
    let fail = 1, allow = true;
    const pi = adapter("pi", { startTurn: vi.fn(async () => { if (fail-- > 0) { allow = false; throw new Error("暂不可用"); } return { turnId: "pi:1" }; }) });
    const settings = async () => ({ backend: "pi" as const, codexReasoningEffort: "high" as const });
    const turns = { records: (inputs: readonly Pick<InputRef, "inboundKey">[]) => inputs.map(i => rec(i.inboundKey)) };
    const router = new BackendRouter({ backends: { pi }, settings, turns, retryMs: 1000, retryDelayMs: 1 });
    const admit = vi.fn(async () => allow);
    expect(await router.startTurn("group:7", [input("s")], { kind: "scheduled", sender: "5", admit })).toEqual({ denied: true });
    expect(pi.startTurn).toHaveBeenCalledTimes(1);
    expect(pi.startTurn).toHaveBeenCalledWith("group:7", expect.any(Array), { kind: "scheduled", sender: "5" }, expect.anything());
    expect(admit).toHaveBeenCalled();
  });
});

describe("TurnMonitor 出错提示（§8.1）", () => {
  function monitor(now: { t: number }) {
    const system = vi.fn(async (_binding: Pick<TurnBinding, "threadKey" | "scope" | "inputKey" | "turnId">, _text: string) => ({ status: "sent" as const, already_sent: false, message_id: "1", message_type: "group" as const, target_id: "7" }));
    const delivered = vi.fn(async () => {}), finish = vi.fn(async () => {});
    const inbox = {
      onDelivered: vi.fn(), onDone: vi.fn(),
      records: (inputs: readonly Pick<InputRef, "inboundKey">[]) => inputs.map(i => rec(i.inboundKey)),
      binding: (threadKey: string): TurnBinding => ({ threadKey, identity: { kind: "wake" }, scope: "group:7", inputs: [] }),
    };
    const m = new TurnMonitor({ inbox, sendService: { system, reconcile: async () => {}, cleanup: async () => {} },
      scheduled: { delivered, finish }, getHost: () => ({ stalled: () => [], interrupt: async () => {} }), now: () => now.t });
    return { m, system, inbox, delivered, finish };
  }
  const ended = (over: Partial<TurnEnded>): TurnEnded => ({ threadKey: "group:7", turnId: "pi:1:1", kind: "user", inputs: [input("a")], status: "failed", ...over });

  it("失败、丢失、投递失败各有文案；同一会话 10 分钟内只提示一次，其他会话不受影响", async () => {
    const now = { t: 0 }, { m, system } = monitor(now);
    m.events.turnEnded!(ended({ status: "lost" }));
    m.events.turnEnded!(ended({ status: "failed" }));
    m.events.turnEnded!(ended({ threadKey: "group:8", turnId: undefined, status: "failed" }));
    await m.idle();
    expect(system.mock.calls.map(c => [c[0].threadKey, c[1]])).toEqual([["group:7", TURN_NOTICES.lost], ["group:8", TURN_NOTICES.undeliverable]]);
    now.t = 10 * 60_000;
    m.events.turnEnded!(ended({ status: "failed" }));
    await m.idle();
    expect(system).toHaveBeenLastCalledWith(expect.objectContaining({ threadKey: "group:7", inputKey: "a", scope: "group:7" }), TURN_NOTICES.failed);
  });

  it("正常结束、定时回合失败与面板停止都不提示；定时输入回报送达与结束", async () => {
    const now = { t: 0 }, { m, system, delivered, finish } = monitor(now);
    m.events.turnEnded!(ended({ status: "completed" }));
    m.events.turnEnded!(ended({ kind: "scheduled", inputs: [{ ...input("run"), kind: "scheduled" }] }));
    await m.stop("group:7");
    m.events.turnEnded!(ended({ status: "failed" }));
    m.events.inputsDelivered!("group:9", "pi:2:2", [{ ...input("run2"), kind: "user" }]);
    await m.idle();
    expect(system).not.toHaveBeenCalled();
    expect(finish).toHaveBeenCalledWith("run", { status: "failed", turnId: "pi:1:1" });
    expect(delivered).not.toHaveBeenCalled();
  });
});
