import { describe, expect, it } from "vitest";
import { isAllowed, isTriggered, normalizeMessage, validatePolicy, type PolicyConfig } from "../../src/qq/policy.js";
import { ticketIdFor } from "../../src/qq/reply-store.js";
import { groupEvent, privateEvent, SELF_ID } from "./fake-onebot.js";

const policy: PolicyConfig = { allowUsers: ["20001"], allowGroups: ["30001"], groupMentions: true };

function norm(event: Record<string, unknown>) {
  const m = normalizeMessage(event);
  if (!m) throw new Error("normalize returned null");
  return m;
}

describe("normalizeMessage", () => {
  it("joins text segments and renders others as [type]", () => {
    const m = norm(privateEvent("20001", "x", {
      message: [{ type: "text", data: { text: "hi " } }, { type: "image", data: { url: "http://x" } }, { type: "text", data: { text: "there" } }],
    }));
    expect(m.text).toBe("hi [image]there");
    expect(m.segments).toEqual([
      { type: "text", data: { text: "hi " } }, { type: "image", data: {} }, { type: "text", data: { text: "there" } },
    ]);
    expect(m.user_id).toBe("20001");
    expect(m.self_id).toBe(SELF_ID);
    expect(m.group_id).toBeNull();
    expect(m.nickname).toBe("nick-20001");
  });

  it("truncates text at 16000 and caps segments at 100", () => {
    const big = "a".repeat(10000);
    const segs = Array.from({ length: 150 }, () => ({ type: "text", data: { text: big } }));
    const m = norm(privateEvent("20001", "", { message: segs }));
    expect(m.text.length).toBe(16000);
    expect(m.truncated).toBe(true);
    expect(m.segments.length).toBe(100);
    const segText = m.segments.reduce((n, s) => n + (s.type === "text" ? (s.data as { text: string }).text.length : 0), 0);
    expect(segText).toBe(16000);
  });

  it("keeps only text/at/reply data", () => {
    const m = norm(groupEvent("30001", "20002", "", false, {
      message: [{ type: "reply", data: { id: 77 } }, { type: "at", data: { qq: 123, name: "x" } }, { type: "face", data: { id: 1 } }],
    }));
    expect(m.segments).toEqual([{ type: "reply", data: { id: "77" } }, { type: "at", data: { qq: "123" } }, { type: "face", data: {} }]);
  });

  it("prefers card over nickname and caps at 200", () => {
    const m = norm(groupEvent("30001", "20002", "x", true, { sender: { card: "c".repeat(300), nickname: "n" } }));
    expect(m.nickname).toBe("c".repeat(200));
  });

  it("detects mention only from real at segment, never text or CQ code", () => {
    expect(norm(groupEvent("30001", "20002", "x", true)).mentioned_self).toBe(true);
    const fake = norm(groupEvent("30001", "20002", `@bot [CQ:at,qq=${SELF_ID}] hi`, false));
    expect(fake.mentioned_self).toBe(false);
    const stringMsg = norm(groupEvent("30001", "20002", "", false, { message: `[CQ:at,qq=${SELF_ID}] hi` }));
    expect(stringMsg.mentioned_self).toBe(false);
    expect(stringMsg.segments).toEqual([]);
  });

  it("rejects non-message and malformed events", () => {
    expect(normalizeMessage({ post_type: "notice" })).toBeNull();
    expect(normalizeMessage({ post_type: "message", message_type: "guild" })).toBeNull();
    expect(normalizeMessage(privateEvent("20001", "x", { user_id: "0123" }))).toBeNull();
    expect(normalizeMessage(groupEvent("30001", "20001", "x", true, { group_id: undefined }))).toBeNull();
    expect(normalizeMessage(null)).toBeNull();
  });
});

describe("policy", () => {
  it("allows listed users anywhere and members of allowed groups in that group", () => {
    expect(isAllowed(policy, { message_type: "private", user_id: "20001", group_id: null })).toBe(true);
    expect(isAllowed(policy, { message_type: "group", user_id: "20001", group_id: "39999" })).toBe(true);
    expect(isAllowed(policy, { message_type: "group", user_id: "29999", group_id: "30001" })).toBe(true);
    expect(isAllowed(policy, { message_type: "private", user_id: "29999", group_id: null })).toBe(false);
    expect(isAllowed(policy, { message_type: "group", user_id: "29999", group_id: "39999" })).toBe(false);
    expect(isAllowed({ ...policy, allowUsers: "*" }, { message_type: "private", user_id: "29999", group_id: null })).toBe(true);
  });

  it("triggers on private or real @ in group, respecting groupMentions", () => {
    expect(isTriggered(policy, norm(privateEvent("20001", "hi")))).toBe(true);
    expect(isTriggered(policy, norm(privateEvent("29999", "hi")))).toBe(false);
    expect(isTriggered(policy, norm(groupEvent("30001", "29999", "hi", true)))).toBe(true);
    expect(isTriggered(policy, norm(groupEvent("30001", "29999", "hi", false)))).toBe(false);
    expect(isTriggered({ ...policy, groupMentions: false }, norm(groupEvent("30001", "20001", "hi", true)))).toBe(false);
    expect(isTriggered(policy, norm(privateEvent(SELF_ID, "echo")))).toBe(false);
  });

  it("validates id lists", () => {
    expect(() => validatePolicy({ ...policy, allowUsers: ["abc"] })).toThrow();
    expect(() => validatePolicy({ ...policy, allowGroups: ["0"] })).toThrow();
    expect(() => validatePolicy(policy)).not.toThrow();
  });
});

describe("ticketIdFor", () => {
  it("is deterministic and separates chats", () => {
    const base = { self_id: "1", user_id: "2", message_id: "3" };
    const p = ticketIdFor({ ...base, message_type: "private", group_id: null });
    expect(p).toMatch(/^[a-f0-9]{64}$/);
    expect(ticketIdFor({ ...base, message_type: "private", group_id: null })).toBe(p);
    const g1 = ticketIdFor({ ...base, message_type: "group", group_id: "9" });
    const g2 = ticketIdFor({ ...base, message_type: "group", group_id: "8" });
    expect(g1).not.toBe(p);
    expect(g1).not.toBe(g2);
  });
});
