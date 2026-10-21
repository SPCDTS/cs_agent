import { describe, expect, it } from "vitest";
import { loadAgentConfig } from "../../src/agent/config.js";
import { threadKeyForSource } from "../../src/agent/codex/runner.js";
import { accessForSource, resolveOwner } from "../../src/context/access.js";
import { isAllowed, isTriggered, normalizeMessage, validatePolicy } from "../../src/qq/policy.js";
import { isOwnerActor } from "../../src/shared/owners.js";
import { groupEvent, privateEvent } from "../qq/fake-onebot.js";

const owners = ["10000001", "10000002"];

describe("多 owner 配置与身份", () => {
  it("首项为主账号，列表去空白和重复项，allowUsers 独立保留", () => {
    const cfg = loadAgentConfig({ QQ_OWNER: ` ${owners[0]}, ${owners[1]},${owners[0]} `, QQ_ALLOW_USERS: "555,666" });
    expect(cfg).toMatchObject({ owner: owners[0], owners, allowUsers: ["555", "666"] });
    expect(resolveOwner(owners.join(","), ["555"])).toBe(owners[0]);
  });

  it("空配置仅回退 allowUsers 第一项，通配符或空名单不产生 owner", () => {
    for (const QQ_OWNER of [undefined, "", "  "]) {
      expect(loadAgentConfig({ QQ_OWNER, QQ_ALLOW_USERS: "111,222" })).toMatchObject({ owner: "111", owners: ["111"] });
      for (const QQ_ALLOW_USERS of ["*", ""]) {
        expect(loadAgentConfig({ QQ_OWNER, QQ_ALLOW_USERS })).toMatchObject({ owner: undefined, owners: [] });
      }
    }
    expect(loadAgentConfig({ QQ_OWNER: owners.join(","), QQ_ALLOW_USERS: "*" })).toMatchObject({ owner: owners[0], owners });
  });

  it.each(["0", "01", "-1", "abc", "*", "qq:123", "1.5", "9007199254740992", "99999999999999999999"])("逐项拒绝无效 QQ 号 %s", invalid => {
    expect(() => loadAgentConfig({ QQ_OWNER: `${owners[0]},${invalid}` })).toThrow(/QQ_OWNER/);
    expect(() => validatePolicy({ owners: [owners[0], invalid], allowUsers: [], allowGroups: [], groupMentions: true })).toThrow(/owners/);
  });

  it.each(owners)("账号 %s 私聊用 owner 线程；群聊仍用本群线程，两者都有 all 访问权", user_id => {
    const source = { type: "private" as const, user_id, group_id: null, nickname: "测试" };
    expect(accessForSource(source, owners)).toEqual({ kind: "all" });
    expect(threadKeyForSource(source, owners)).toBe("owner");
    const group = { ...source, type: "group" as const, group_id: "42" };
    expect(accessForSource(group, owners)).toEqual({ kind: "all" });
    expect(threadKeyForSource(group, owners)).toBe("group:42");
    expect(isOwnerActor(owners, `qq:${user_id}`)).toBe(true);
    expect(isOwnerActor(owners, user_id)).toBe(false);
  });

  it("普通私聊保持隔离，owner 身份需要完整匹配", () => {
    const source = { type: "private" as const, user_id: "555", group_id: null, nickname: "测试" };
    expect(accessForSource(source, owners)).toEqual({ kind: "scope", scope: "private:555" });
    expect(threadKeyForSource(source, owners)).toBe("private:555");
    expect(isOwnerActor(owners, "qq:384563185")).toBe(false);
    expect(isOwnerActor([], "qq:undefined")).toBe(false);
  });

  it("所有 owner 无需在 allowUsers 中，群聊仍遵守真实 @ 和群触发开关", () => {
    const policy = { owners, allowUsers: [], allowGroups: [], groupMentions: true };
    for (const user of owners) {
      const privateMessage = normalizeMessage(privateEvent(user, "你好"))!;
      expect(isAllowed(policy, privateMessage)).toBe(true);
      expect(isTriggered(policy, privateMessage)).toBe(true);
      const group = normalizeMessage(groupEvent("42", user, "你好", true))!;
      expect(isTriggered(policy, group)).toBe(true);
      expect(isTriggered({ ...policy, groupMentions: false }, group)).toBe(false);
      expect(isTriggered(policy, { ...group, mentioned_self: false })).toBe(false);
    }
    expect(isAllowed(policy, { message_type: "private", user_id: "555", group_id: null })).toBe(false);
    expect(policy.allowUsers).toEqual([]);
  });
});
