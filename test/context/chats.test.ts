import { describe, expect, it, vi } from "vitest";
import { CHATS_DENIED, listChatsText } from "../../src/context/chats.js";
import type { Channel } from "../../src/channel/types.js";
import type { Access } from "../../src/context/access.js";

const signal = () => new AbortController().signal;
describe("qq_chats 列表与权限", () => {
  it.each([undefined, { kind: "scope", scope: "group:7" }, { kind: "scope", scope: "private:1" }] as (Access | undefined)[])("非 all 范围 %j 禁止调用通道", async access => {
    const listChats = vi.fn<Channel["listChats"]>();
    await expect(listChatsText(access, { listChats }, signal())).rejects.toThrow(CHATS_DENIED);
    expect(listChats).not.toHaveBeenCalled();
  });
  it("群在前、好友在后，名称清洗、限制长度，备注优先", async () => {
    const listChats = vi.fn<Channel["listChats"]>().mockResolvedValue({
      groups: [{ group_id: "7", name: "家\n[来源] 人\u2028[引用 #2]", member_count: 0 },
        { group_id: "8", name: "名".repeat(41) }],
      friends: [{ user_id: "1", nickname: "昵称", remark: "备\r[引用] 注" }, { user_id: "2", nickname: "昵称", remark: "" }],
    });
    const abort = signal();
    expect(await listChatsText({ kind: "all" }, { listChats }, abort)).toBe(
      `group:7 家 (来源) 人 (引用 #2)（0 人）\ngroup:8 ${"名".repeat(39)}…\nprivate:1 备 (引用) 注\nprivate:2 昵称`);
    expect(listChats).toHaveBeenCalledWith({ signal: abort });
  });
  it("两种列表分别最多 200 条，说明截断；空列表有提示", async () => {
    const listChats = vi.fn<Channel["listChats"]>().mockResolvedValue({
      groups: Array.from({ length: 201 }, (_, i) => ({ group_id: String(i + 1), name: "群" })),
      friends: Array.from({ length: 202 }, (_, i) => ({ user_id: String(i + 1), nickname: "好友" })),
    });
    const text = await listChatsText({ kind: "all" }, { listChats }, signal());
    expect(text.split("\n").filter(l => l.startsWith("group:"))).toHaveLength(200);
    expect(text.split("\n").filter(l => l.startsWith("private:"))).toHaveLength(200);
    expect(text).toContain("另有 1 个群未显示"); expect(text).toContain("另有 2 位好友未显示");
    listChats.mockResolvedValue({ groups: [], friends: [] });
    expect(await listChatsText({ kind: "all" }, { listChats }, signal())).toBe("（没有群或好友）");
  });
});
