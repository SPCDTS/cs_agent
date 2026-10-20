import type { Channel } from "../channel/types.js";
import { headerNickname } from "../shared/header.js";
import { abortable } from "./media.js";
import type { Access } from "./access.js";

export const CHATS_DENIED = "qq_chats 仅限主人私聊（access=all）使用。";
const CHAT_LIMIT = 200;

export async function listChatsText(access: Access | undefined, channel: Pick<Channel, "listChats"> | undefined, signal: AbortSignal): Promise<string> {
  if (access?.kind !== "all") throw new Error(CHATS_DENIED);
  if (!channel) throw new Error("会话列表未启用");
  signal.throwIfAborted();
  const { groups, friends } = await abortable(channel.listChats({ signal }), signal);
  const lines = groups.slice(0, CHAT_LIMIT).map(g =>
    `group:${g.group_id} ${headerNickname(g.name)}${g.member_count === undefined ? "" : `（${g.member_count} 人）`}`);
  if (groups.length > CHAT_LIMIT) lines.push(`（另有 ${groups.length - CHAT_LIMIT} 个群未显示）`);
  lines.push(...friends.slice(0, CHAT_LIMIT).map(f => `private:${f.user_id} ${headerNickname(f.remark || f.nickname)}`));
  if (friends.length > CHAT_LIMIT) lines.push(`（另有 ${friends.length - CHAT_LIMIT} 位好友未显示）`);
  return lines.join("\n") || "（没有群或好友）";
}
