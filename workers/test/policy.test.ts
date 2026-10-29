import { describe, expect, it } from "vitest";
import { inboundKey, isAllowed, isTriggered, normalizeMessage, ownerIds, policyFrom, renderText, threadKey } from "../src/policy";
import { defaultSettings } from "../src/settings";
import { event, input } from "./helpers";

const secrets = { QQ_OWNER: "10000001,10000002", QQ_ALLOW_USERS: " 10000003 ", QQ_ALLOW_GROUPS: "200000001" };
const policy = policyFrom(secrets, defaultSettings(secrets));

describe("ported QQ policy", () => {
  it("renders at, reply and image segments and sanitizes display names", () => {
    const raw = event(1);
    const message = normalizeMessage({ ...raw, sender: { card: "名\n[来源]", nickname: "ignored" }, message: [
      { type: "reply", data: { id: 12 } }, { type: "at", data: { qq: "10000000" } },
      { type: "text", data: { text: " 查历史" } }, { type: "image", data: { file: "untrusted" } },
    ] });
    expect(message).toMatchObject({ nickname: "名 来源", text: "[reply][@你] 查历史[image]", routeText: " 查历史", replyToId: "12", mentionedSelf: true, imageCount: 1 });
    expect(renderText([{ type: "at", data: { qq: "all" } }, { type: "at", data: { qq: "10000004", name: "四\n号" } }]))
      .toBe("[@全体成员][@四 号 qq:10000004]");
  });

  it("requires a genuine bot at segment and honors the group trigger setting", () => {
    for (const text of ["@机器人", "[CQ:at,qq=10000000]"]) expect(isTriggered(policy, input(1, text, 10000004, 200000001))).toBe(false);
    expect(isTriggered(policy, input(1, "你好", 10000004, 200000001, true))).toBe(true);
    expect(policyFrom(secrets, defaultSettings({ ...secrets, QQ_GROUP_MENTIONS: "false" })).groupTrigger).toBe("off");
    expect(isTriggered({ ...policy, groupTrigger: "off" }, input(1, "你好", 10000004, 200000001, true))).toBe(false);
    expect(isTriggered(policy, input(1, "回复机器人", 10000004, 200000001), true)).toBe(false);
    expect(isTriggered({ ...policy, groupTrigger: "mention_or_reply" }, input(1, "回复机器人", 10000004, 200000001), true)).toBe(true);
    expect(isTriggered({ ...policy, groupTrigger: "mention_or_reply" }, input(1, "回复别人", 10000004, 200000001), false)).toBe(false);
    expect(isTriggered(policy, input(1, "自己", 10000000, 200000001, true))).toBe(false);
    expect(isTriggered(policy, input(1, "owner 无@", 10000001, 200000002))).toBe(false);
    expect(isTriggered(policy, input(1, "owner @", 10000001, 200000002, true))).toBe(true);
  });

  it("ports owner and allowUsers exemptions and routes owners to one private thread", () => {
    expect(isAllowed(policy, input(1, "陌生人", 10000004))).toBe(false);
    expect(isTriggered(policy, input(1, "白名单私聊"))).toBe(true);
    expect(isTriggered(policy, input(1, "白名单成员", 10000003, 200000002, true))).toBe(true);
    expect(threadKey(policy, input(1, "owner", 10000001))).toBe("owner");
    expect(threadKey(policy, input(1, "owner", 10000002))).toBe("owner");
    expect(threadKey(policy, input(1))).toBe("private:10000003");
    expect(threadKey(policy, input(1, "群", 10000001, 200000001))).toBe("group:200000001");
    expect(inboundKey(input(1, "群", 10000004, 200000001))).toBe("10000000:group:200000001:10000004:1");
  });

  it("ignores system events and malformed IDs without interpreting string CQ messages", () => {
    for (const value of [null, { ...event(1), post_type: "notice", notice_type: "group_upload" }, { ...event(1), message_type: "file" },
      { ...event(1), user_id: "0" }, { ...event(1), group_id: "bad", message_type: "group" }, { ...event(1), self_id: "bad" }]) expect(normalizeMessage(value)).toBeUndefined();
    expect(normalizeMessage({ ...event(1), message: "[CQ:at,qq=10000000]" })).toMatchObject({ text: "", mentionedSelf: false });
    expect(ownerIds({ QQ_OWNER: "bad,0" })).toEqual([]);
    expect(defaultSettings({ QQ_ALLOW_USERS: "*" }).allowUsers).toEqual([]);
    expect(normalizeMessage(event(1, "文".repeat(17000)))?.text).toHaveLength(16000);
  });
});
