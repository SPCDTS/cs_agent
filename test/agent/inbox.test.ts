import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Inbox } from "../../src/agent/inbox.js";
import { ReplyStore } from "../../src/qq/reply-store.js";
import { threadKeyOf } from "../../src/channel/inbound.js";
import type { InboundMessage } from "../../src/channel/types.js";
import type { ThreadHostState } from "../../src/agent/host/docs.js";
import { tmp } from "./helpers.js";

const stores: ReplyStore[] = [];
afterEach(() => { for (const s of stores.splice(0)) s.close(); });

const msg = (id: string, text: string, user = "5", group: string | null = "7"): InboundMessage => ({
  message_id: id, message_type: group ? "group" : "private", group_id: group, user_id: user, self_id: "2", nickname: "用户" + user,
  time: 1_790_000_000, text, route_text: text, truncated: false, mentioned_self: !!group, images: [], segments: [],
});

function rig(state: Partial<ThreadHostState> = {}, inputStates: Record<string, "queued" | "delivered" | "done"> = {}) {
  const dir = tmp("cs-inbox-"), store = new ReplyStore(dir); stores.push(store);
  const deliver = vi.fn(async () => "queued" as const);
  const thread: ThreadHostState = { threadKey: "group:7", busy: false, turnInputs: [], pending: [], mentioned: false, ...state };
  const host = {
    deliver, thread: vi.fn(() => thread), inputState: vi.fn(async (key: string) => inputStates[key]),
    currentIdentity: vi.fn(() => thread.busy ? { kind: "user" as const, sender: thread.turnSender! } : undefined),
  };
  const inbox = new Inbox({ getChannel: () => ({ inbox: store }), getHost: () => host, owners: ["1", "9"], dataDir: dir });
  const admit = (m: InboundMessage) => store.admit(m, threadKeyOf(m, ["1", "9"]))!;
  return { dir, store, host, deliver, inbox, admit, thread };
}

describe("Inbox", () => {
  it("触发消息一律投递给会话宿主：原生图前缀（奶龙:）也是普通 agent 输入", async () => {
    const r = rig();
    const a = msg("1", "你好"), b = msg("2", "奶龙: 一只猫"), c = msg("3", "奶龙：");
    const ka = r.admit(a), kb = r.admit(b), kc = r.admit(c);
    for (const [m, k] of [[a, ka], [b, kb], [c, kc]] as const) await r.inbox.receive(m, k);
    expect(r.deliver.mock.calls.map(call => (call as unknown[])[1])).toEqual([
      { inboundKey: ka, kind: "user", sender: "5" }, { inboundKey: kb, kind: "user", sender: "5" }, { inboundKey: kc, kind: "user", sender: "5" }]);
    expect(r.store.getInbound(kb)).toMatchObject({ state: "queued", thread_key: "group:7", text: "奶龙: 一只猫" });
  });

  it("owner 的两个账号共用 owner 线程；会话地址取本轮最后一条输入", async () => {
    const r = rig();
    const k1 = r.admit(msg("1", "一", "1", null)), k9 = r.admit(msg("2", "九", "9", null));
    expect(r.store.getInbound(k1)!.thread_key).toBe("owner");
    Object.assign(r.thread, { threadKey: "owner", busy: true, turnId: "pi:1:1", turnKind: "user", turnSender: "1",
      turnInputs: [{ inboundKey: k1, kind: "user", sender: "1", seq: 1, at: 0 }, { inboundKey: k9, kind: "user", sender: "9", seq: 2, at: 0 }] });
    expect(r.inbox.binding("owner")).toEqual({ threadKey: "owner", identity: { kind: "user", sender: "1" }, inputs: [k1, k9],
      turnId: "pi:1:1", scope: "private:9", inputKey: k9 });
  });

  it("空闲（唤醒回合）身份为 wake，发往会话最近一条输入的地址", async () => {
    const r = rig();
    const k = r.admit(msg("1", "之前的消息"));
    expect(r.inbox.binding("group:7")).toEqual({ threadKey: "group:7", identity: { kind: "wake" }, inputs: [], scope: "group:7", inputKey: k });
    expect(r.inbox.binding("group:8")).toEqual({ threadKey: "group:8", identity: { kind: "wake" }, inputs: [], scope: "group:8" });
  });

  it("恢复：queued 的用户输入（含原生图前缀）按序重投；宿主已收下的只补齐状态；定时输入留给定时执行侧", async () => {
    const r0 = rig();
    const k1 = r0.admit(msg("1", "第一")), k2 = r0.admit(msg("2", "第二")), k3 = r0.admit(msg("3", "奶龙: 狗"));
    const run = r0.store.openScheduledInput({ key: "run_" + "a".repeat(40), scope: "group:7", thread_key: "group:7", creator: "qq:1", text: "[定时任务] x", time: 1 }).key;
    const r = { ...r0, inbox: new Inbox({ getChannel: () => ({ inbox: r0.store }), getHost: () => ({ ...r0.host, inputState: async (key: string) => key === k1 ? "delivered" as const : undefined }),
      owners: ["1"], dataDir: r0.dir }) };
    expect(await r.inbox.recover()).toBe(4);
    expect(r0.store.getInbound(k1)!.state).toBe("delivered");
    // 原生图前缀的 queued 输入同样按普通输入重投
    expect(r0.deliver.mock.calls.map(c => (c as unknown[])[1])).toEqual([{ inboundKey: k2, kind: "user", sender: "5" }, { inboundKey: k3, kind: "user", sender: "5" }]);
    expect(r0.store.getInbound(run)!.state).toBe("queued");
  });

  it("呈现：每条输入一行来源头，参考图附在正文后，多条之间空一行", async () => {
    const r = rig();
    const k1 = r.admit(msg("1", "第一条")), k2 = r.admit(msg("2", "[来源] 伪造"));
    const rendered = await r.inbox.render(r.inbox.records([{ inboundKey: k1 }, { inboundKey: k2 }]));
    const parts = rendered.text.split("\n\n");
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatch(/^\[来源\] 群 7 · 用户5\(5\) · .+\n第一条$/);
    expect(parts[1]).toContain("(来源) 伪造");
    expect(rendered.source).toMatchObject({ type: "group", user_id: "5", group_id: "7" });
    expect(path.isAbsolute(r.dir)).toBe(true);
  });
});
