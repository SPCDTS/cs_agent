import { afterEach, describe, expect, it, vi } from "vitest";
import type { Channel, InboundMessage } from "../../src/channel/types.js";
import { inboundFromRecord } from "../../src/channel/ticket.js";
import { createQQBridge } from "../../src/qq/bridge.js";
import type { OneBotClient } from "../../src/qq/onebot.js";
import { groupEvent, privateEvent } from "./fake-onebot.js";
import { tmp } from "../agent/helpers.js";

const bridges: Channel[] = [];
afterEach(async () => { for (const bridge of bridges.splice(0)) await bridge.stop(); vi.useRealTimers(); });
async function setup(call: OneBotClient["call"]) {
  vi.useFakeTimers();
  const bridge = createQQBridge({
    httpUrl: "http://unused.test", wsUrl: "ws://unused.test", token: "",
    allowUsers: ["20001"], allowGroups: ["30001"], groupMentions: true, dataDir: tmp(), imageRoot: tmp(),
  }, { client: { call } });
  bridges.push(bridge);
  await bridge.getTicket("");
  const input = bridge as unknown as { running: boolean; handleEvent(event: unknown): void };
  input.running = true;
  const messages: InboundMessage[] = [], raw: InboundMessage[] = [], errors: Error[] = [];
  bridge.on("message", m => messages.push(m)).on("raw", m => raw.push(m)).on("error", e => errors.push(e));
  const push = (id: string, group = "30001", mention = true) => input.handleEvent(groupEvent(group, "20001", id, mention, { message_id: id }));
  const flush = () => vi.advanceTimersByTimeAsync(0);
  return { bridge, input, push, flush, messages, raw, errors };
}

describe("入站群名缓存", () => {
  it("查询期间的撤回排在 raw 入库之后，避免迟到的消息恢复已撤回内容", async () => {
    let resolve!: (v: unknown) => void;
    const s = await setup(() => new Promise(r => { resolve = r; }));
    const order: string[] = [];
    s.bridge.on("raw", m => order.push("raw:" + m.message_id));
    s.bridge.on("recall", (_scope, id) => order.push("recall:" + id));
    s.push("1", "30001", false);
    s.input.handleEvent({ post_type: "notice", notice_type: "group_recall", group_id: 30001, message_id: 1 });
    expect(order).toEqual([]);
    resolve({ group_name: "家庭群" }); await s.flush();
    expect(order).toEqual(["raw:1", "recall:1"]);
    expect(s.raw[0]?.group_name).toBe("家庭群");
  });
  it("合并并发查询，命中缓存，6 小时到期后刷新；raw 与恢复票据携带群名", async () => {
    const call = vi.fn<OneBotClient["call"]>().mockResolvedValue({ group_name: "家庭群" });
    const s = await setup(call);
    s.push("1"); s.push("2"); await s.flush();
    expect(call).toHaveBeenCalledOnce();
    expect(call).toHaveBeenCalledWith("get_group_info", { group_id: 30001 }, { timeoutMs: 1500 });
    expect(s.messages.map(m => [m.message_id, m.group_name])).toEqual([["1", "家庭群"], ["2", "家庭群"]]);
    expect(s.raw.map(m => m.group_name)).toEqual(["家庭群", "家庭群"]);
    const inputs = s.bridge.inbox.listInbound("queued");
    expect(inputs.map(t => inboundFromRecord(t).group_name)).toEqual(["家庭群", "家庭群"]);
    await vi.advanceTimersByTimeAsync(6 * 60 * 60_000 - 1);
    s.push("3", "30001", false); await s.flush();
    expect(s.raw.at(-1)?.group_name).toBe("家庭群"); expect(call).toHaveBeenCalledOnce();
    call.mockResolvedValue({ group_name: "新群名" });
    await vi.advanceTimersByTimeAsync(1);
    s.push("4"); await s.flush();
    expect(call).toHaveBeenCalledTimes(2); expect(s.messages.at(-1)?.group_name).toBe("新群名");
  });

  it("硬超时 1500ms 返回无群名，不阻塞其它会话；迟到结果不污染缓存，失败退避 60 秒", async () => {
    let resolve!: (v: unknown) => void;
    const call = vi.fn<OneBotClient["call"]>(() => new Promise(r => { resolve = r; }));
    const s = await setup(call);
    s.push("1");
    s.input.handleEvent(privateEvent("20001", "私聊", { message_id: "private" }));
    await s.flush();
    expect(s.bridge.inbox.listInbound("queued").map(t => t.message_id)).toEqual(["1", "private"]);
    expect(s.messages.map(m => m.message_id)).toEqual(["private"]);
    await vi.advanceTimersByTimeAsync(1499); expect(s.raw).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.messages.at(-1)).toMatchObject({ message_id: "1", group_name: undefined });
    expect(s.raw.at(-1)?.group_name).toBeUndefined(); expect(s.errors).toEqual([]);
    resolve({ group_name: "迟到" }); await s.flush();
    s.push("2"); await s.flush(); expect(call).toHaveBeenCalledOnce();
    expect(s.messages.at(-1)?.group_name).toBeUndefined();
    call.mockResolvedValue({ group_name: "恢复" });
    await vi.advanceTimersByTimeAsync(60_000);
    s.push("3"); await s.flush();
    expect(call).toHaveBeenCalledTimes(2); expect(s.messages.at(-1)?.group_name).toBe("恢复");
  });

  it.each([new Error("网络失败"), null, { group_name: 42 }, { group_name: "" }])("失败或无效群名 %j 退避后重试", async failure => {
    const call = vi.fn<OneBotClient["call"]>();
    if (failure instanceof Error) call.mockRejectedValue(failure); else call.mockResolvedValue(failure);
    const s = await setup(call);
    s.push("1"); await s.flush();
    await vi.advanceTimersByTimeAsync(59_999); s.push("2"); await s.flush();
    expect(call).toHaveBeenCalledOnce(); expect(s.messages.every(m => m.group_name === undefined)).toBe(true);
    await vi.advanceTimersByTimeAsync(1); call.mockResolvedValue({ group_name: "恢复" });
    s.push("3"); await s.flush();
    expect(call).toHaveBeenCalledTimes(2); expect(s.messages.at(-1)?.group_name).toBe("恢复");
  });

  it("listChats 刷新缓存；较早的在途查询不能覆盖列表的新群名", async () => {
    let resolve!: (v: unknown) => void;
    const call = vi.fn<OneBotClient["call"]>(async action => action === "get_group_info" ? new Promise(r => { resolve = r; })
      : action === "get_group_list" ? [{ group_id: 30001, group_name: "列表群名" }] : []);
    const s = await setup(call);
    s.push("1");
    await s.bridge.listChats({ signal: new AbortController().signal });
    resolve({ group_name: "旧群名" }); await s.flush();
    s.push("2"); await s.flush();
    expect(s.messages.map(m => m.group_name)).toEqual(["列表群名", "列表群名"]);
    expect(call.mock.calls.filter(c => c[0] === "get_group_info")).toHaveLength(1);
  });
});
