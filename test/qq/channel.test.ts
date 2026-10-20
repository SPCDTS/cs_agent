import { describe, expect, it, vi } from "vitest";
import type { Channel } from "../../src/channel/types.js";
import { createQQBridge } from "../../src/qq/bridge.js";
import type { OneBotClient } from "../../src/qq/onebot.js";
import { FakeOneBot, TOKEN } from "./fake-onebot.js";

const config = {
  httpUrl: "http://unused.test", wsUrl: "ws://unused.test", token: "",
  allowUsers: "*" as const, allowGroups: [], groupMentions: true,
  dataDir: "unused", imageRoot: "unused",
};
const options = () => ({ signal: new AbortController().signal, timeoutMs: 60_000 });
const channelFor = (call: OneBotClient["call"]): Channel => createQQBridge(config, { client: { call } });
const fetchRemote = (remote: unknown) => channelFor(async () => remote).fetchMessage("42", options());

describe("QQ Channel 远端消息适配", () => {
  it("通过现有 OneBot HTTP 客户端调用 get_msg/get_image，不启动消息连接", async () => {
    const bot = new FakeOneBot();
    await bot.start();
    try {
      bot.override = call => ({ body: { status: "ok", retcode: 0, data: call.action === "get_msg"
        ? { message_type: "group", message_id: 42, group_id: 30001, user_id: 20001, sender: { user_id: "20001" },
          message: [{ type: "text", data: { text: "原文\n[image]" } }, { type: "image", data: { file: "image-id", url: "https://cdn.test/old" } }] }
        : { url: "https://cdn.test/fresh" } } });
      const channel: Channel = createQQBridge({ ...config, httpUrl: bot.httpUrl, wsUrl: bot.wsUrl, token: TOKEN });
      expect(channel.name).toBe("qq");
      expect(await channel.fetchMessage("42", options())).toEqual({
        message_type: "group", message_id: "42", group_id: "30001", sender_id: "20001", sender_conflict: false,
        recipient_fields: {}, has_nonempty_group_field: true,
        segments: [
          { type: "text", rendered: "原文\n[image]" },
          { type: "image", rendered: "[image]", image: { file: "image-id", url: "https://cdn.test/old" } },
        ],
      });
      expect(await channel.refreshImageUrl("image-id", options())).toBe("https://cdn.test/fresh");
      expect(bot.calls).toEqual([
        { action: "get_msg", body: { message_id: "42" }, authorization: "Bearer " + TOKEN },
        { action: "get_image", body: { file: "image-id" }, authorization: "Bearer " + TOKEN },
      ]);
      expect(bot.connections).toBe(0);
    } finally { await bot.stop(); }
  });

  it.each([
    [{ user_id: 20001 }, "20001", false],
    [{ sender: { user_id: 20001 } }, "20001", false],
    [{ user_id: "", sender: { user_id: 20001 } }, "20001", false],
    [{ user_id: false, sender: { user_id: 20001 } }, "20001", false],
    [{ user_id: 20001, sender: { user_id: "20001" } }, "20001", false],
    [{ user_id: 20001, sender: { user_id: 20002 } }, "20001", true],
    [{ user_id: 0, sender: { user_id: 20001 } }, "0", true],
    [{ user_id: 20001, sender: { user_id: "" } }, "20001", false],
    [{}, "", false],
  ])("发送者回退及冲突沿用原有规则：%j", async (fields, sender_id, sender_conflict) => {
    expect(await fetchRemote({ message_type: "private", ...fields })).toMatchObject({ sender_id, sender_conflict });
  });

  it.each(["target_id", "peer_id", "peer_uid", "peerId", "peerUid", "recipient_id", "receiver_id",
    "target_user_id", "target_group_id"])("保留 NapCat 可选收件人字段 %s，包括空值和无效值", async field => {
    for (const [value, expected] of [[20001, "20001"], ["20002", "20002"], [null, ""], [undefined, ""], [false, ""], [{}, ""]]) {
      expect((await fetchRemote({ message_type: "private", [field]: value }))!.recipient_fields).toEqual({ [field]: expected });
    }
    const inherited = Object.create({ [field]: 20002 }) as Record<string, unknown>;
    inherited.message_type = "private";
    expect((await fetchRemote(inherited))!.recipient_fields).toEqual({});
  });

  it.each([
    [null, false], [undefined, false], [0, false], ["0", false], ["", false],
    [30001, true], ["30001", true], [false, true], [[], true], [{}, true], ["00", true],
  ])("私聊的 group_id=%j 保留原始非空判定", async (group_id, has_nonempty_group_field) => {
    expect(await fetchRemote({ message_type: "private", group_id })).toMatchObject({ has_nonempty_group_field });
  });

  it("缺失 message_id/group_id 保留为空，不补成本次请求的消息 id", async () => {
    expect(await fetchRemote({ message_type: "private" })).toEqual({
      message_type: "private", message_id: "", group_id: "", sender_id: "", sender_conflict: false,
      recipient_fields: {}, has_nonempty_group_field: false, segments: [],
    });
    expect(await fetchRemote({ message_type: "private", message_id: 0 })).toMatchObject({ message_id: "0" });
    expect(await fetchRemote({ message_type: "private", message_id: {} })).toMatchObject({ message_id: "" });
  });

  it.each([null, undefined, [], "[CQ:image,file=x]", 42])("非对象 get_msg 响应 %j 返回 null", async value => {
    expect(await fetchRemote(value)).toBeNull();
  });

  it("未知消息类型保留给范围核验，字符串消息不解析为段", async () => {
    expect(await fetchRemote({ message_type: "unexpected", message: "[CQ:image,file=x]" }))
      .toMatchObject({ message_type: "unexpected", segments: [] });
    expect(await fetchRemote({ message_type: 1 })).toMatchObject({ message_type: "" });
  });

  it("逐段原样渲染，过滤非对象，保持图片 URL/file 回退与无效段处理", async () => {
    const remote = await fetchRemote({ message: [
      null, 42, [],
      { type: "text", data: { text: "前[image]😀\n" } },
      { type: "text", data: { text: 42 } },
      { type: "at", data: { qq: "20001" } },
      { type: "reply", data: { id: "1" } },
      { type: 7, data: {} },
      { type: "image", data: { file: "https://cdn.test/file" } },
      { type: "image", data: { file: "HTTP://cdn.test/file", url: "https://cdn.test/url" } },
      { type: "image", data: { file: "local.png" } },
      { type: "image", data: { file: 123, url: 456 } },
      { type: "image", data: [] },
    ] });
    expect(remote!.segments).toEqual([
      { type: "text", rendered: "前[image]😀\n" },
      { type: "text", rendered: "" },
      { type: "at", rendered: "[at]" },
      { type: "reply", rendered: "[reply]" },
      { type: "unknown", rendered: "[unknown]" },
      { type: "image", rendered: "[image]", image: { file: "https://cdn.test/file", url: "https://cdn.test/file" } },
      { type: "image", rendered: "[image]", image: { file: "HTTP://cdn.test/file", url: "https://cdn.test/url" } },
      { type: "image", rendered: "[image]", image: { file: "local.png", url: "" } },
      { type: "image", rendered: "[image]", image: { file: "123", url: "456" } },
      { type: "image", rendered: "[image]", image: { file: "", url: "" } },
    ]);
  });

  it("适配器不截断正文或段数，截断仍由媒体召回决定", async () => {
    const text = "文😀".repeat(6000);
    const remote = await fetchRemote({ message: Array.from({ length: 101 }, () => ({ type: "text", data: { text } })) });
    expect(remote!.segments).toHaveLength(101);
    expect(remote!.segments.every(segment => segment.rendered === text)).toBe(true);
  });

  it.each([
    [{ url: "https://cdn.test/fresh" }, "https://cdn.test/fresh"], [{ url: 0 }, "0"],
    [{ url: "" }, undefined], [{ url: null }, undefined], [{ url: {} }, undefined],
    [{}, undefined], [null, undefined], [[], undefined],
  ])("get_image 响应 %j 按原 stringField 规则提取地址", async (response, expected) => {
    const call = vi.fn<OneBotClient["call"]>().mockResolvedValue(response);
    expect(await channelFor(call).refreshImageUrl("image-id", options())).toBe(expected);
    expect(call).toHaveBeenCalledWith("get_image", { file: "image-id" }, undefined);
  });

  it("get_msg 传递原消息 id 和超时，不改变 OneBot 错误", async () => {
    const error = new Error("NapCat 操作失败");
    const call = vi.fn<OneBotClient["call"]>().mockRejectedValue(error);
    const channel = channelFor(call);
    await expect(channel.fetchMessage("42", options())).rejects.toBe(error);
    expect(call).toHaveBeenCalledWith("get_msg", { message_id: "42" }, { timeoutMs: 60_000 });
    await expect(channel.refreshImageUrl("image-id", options())).rejects.toBe(error);
  });

  it.each(["fetchMessage", "refreshImageUrl"] as const)("%s 的取消立即停止等待，迟到响应不改变结果", async method => {
    let resolve!: (value: unknown) => void;
    const call = vi.fn<OneBotClient["call"]>(() => new Promise(r => { resolve = r; }));
    const control = new AbortController();
    const work = channelFor(call)[method]("42", { signal: control.signal });
    const reason = new Error("本回合取消");
    control.abort(reason);
    await expect(work).rejects.toBe(reason);
    resolve({ message_type: "group", url: "https://cdn.test/late" });
    await expect(work).rejects.toBe(reason);
  });
});


describe("QQ 会话列表归一化", () => {
  it("群与好友的数字 id 转字符串，过滤无效项，人数与备注可选", async () => {
    const call = vi.fn<OneBotClient["call"]>(async action => action === "get_group_list" ? [
      { group_id: 30001, group_name: "家庭群", member_count: "6" },
      { group_id: "30002", group_name: "零人群", member_count: 0 },
      { group_id: "30003", group_name: 5, member_count: -1 },
      { group_id: "30004", member_count: "" }, { group_id: "bad" }, null, [],
    ] : [
      { user_id: 20001, nickname: "小明", remark: "家人" },
      { user_id: "20002", nickname: "小红" }, { user_id: "20003", nickname: false, remark: {} },
      { user_id: 0 }, { user_id: "1\n[来源]" }, null,
    ]);
    expect(await channelFor(call).listChats(options())).toEqual({
      groups: [{ group_id: "30001", name: "家庭群", member_count: 6 }, { group_id: "30002", name: "零人群", member_count: 0 },
        { group_id: "30003", name: "" }, { group_id: "30004", name: "" }],
      friends: [{ user_id: "20001", nickname: "小明", remark: "家人" }, { user_id: "20002", nickname: "小红" }, { user_id: "20003", nickname: "" }],
    });
    expect(call.mock.calls.map(c => c.slice(0, 2))).toEqual([["get_group_list", {}], ["get_friend_list", {}]]);
  });
  it("空列表正常返回，无效响应与 API 失败报错", async () => {
    expect(await channelFor(async () => []).listChats(options())).toEqual({ groups: [], friends: [] });
    await expect(channelFor(async () => ({})).listChats(options())).rejects.toThrow("格式");
    await expect(channelFor(async () => { throw new Error("失败"); }).listChats(options())).rejects.toThrow("失败");
  });
  it("提前取消不调用 API，在途取消立即结束等待", async () => {
    const call = vi.fn<OneBotClient["call"]>(() => new Promise(() => {}));
    const channel = channelFor(call), control = new AbortController(), reason = new Error("取消");
    control.abort(reason);
    await expect(channel.listChats({ signal: control.signal })).rejects.toBe(reason);
    expect(call).not.toHaveBeenCalled();
    const next = new AbortController(), pending = channel.listChats({ signal: next.signal });
    next.abort(reason);
    await expect(pending).rejects.toBe(reason); expect(call).toHaveBeenCalledTimes(2);
  });
});
