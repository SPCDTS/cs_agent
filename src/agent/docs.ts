import { defineDoc } from "@earendil-works/pi-durable";

export type TicketSource = {
  type: "private" | "group";
  user_id: string;
  group_id: string | null;
  nickname: string;
};

/** 每个 QQ 消息会话的文档：reply_qq 只从这里取 ticket，模型无法指定回复目标。 */
export type TicketState = {
  ticket: string;
  source: TicketSource;
  text: string;
  /** 已调用的业务工具名（generate_image / ask_codex），空串表示尚未调用 */
  business: string;
  /** generate_image 成功产出的图片 realpath；reply_qq 只接受其中的路径（旧文档可能没有此字段） */
  images?: string[];
  /** generate_image 成功时的最终英文提示词（写入消息库机器人行的 detail） */
  imagePrompt?: string;
  /** ask_codex 本轮推理强度（"default" 表示沿用 config.toml） */
  codexEffort?: string;
  /** reply_qq 成功发送的正文与图片数 */
  replyText?: string;
  replyImages?: number;
  /** 入站消息时间（unix 秒）与 message_id（ask_codex 头部 / 引用查找用） */
  time?: number;
  messageId?: string;
  /** 入站消息 reply 段引用的 message_id */
  replyTo?: string;
};

export const TicketDoc = defineDoc<TicketState>({
  kind: "cs.ticket",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({
    ticket: "",
    source: { type: "private", user_id: "", group_id: null, nickname: "" },
    text: "",
    business: "",
  }),
});

/**
 * Session 级派发索引：ticket → conversationId（以及原始提交内容）。
 * 仅保存未完成的票据；票据进入终态（sent/uncertain）后才删除，基础设施错误时保留，
 * 重启后据此重新 submit（requestId=ticket 去重）。attempts 为已开始运行的次数。
 */
export type DispatchEntry = { conversationId: number; content: string; attempts?: number };
export type DispatchState = { pending: Record<string, DispatchEntry> };

export const DispatchDoc = defineDoc<DispatchState>({
  kind: "cs.dispatch",
  version: 1,
  scope: "session",
  initial: () => ({ pending: {} }),
});

/** 业务工具守卫：每个会话只允许一次业务工具调用；返回 false 表示已用过。 */
export async function claimBusinessCall(
  api: { conversationId: import("@earendil-works/pi-durable").ConversationId; commit: <T>(fn: (tx: import("@earendil-works/pi-durable").Tx) => T | Promise<T>, c: import("@earendil-works/chord").Context) => Promise<T> },
  tool: string,
  context: import("@earendil-works/chord").Context,
): Promise<boolean> {
  return api.commit(async (tx) => {
    const doc = await tx.doc(TicketDoc, api.conversationId);
    if (doc.business) return false;
    doc.business = tool;
    return true;
  }, context);
}

export const BUSINESS_ALREADY_USED = "本条消息已经调用过业务工具，禁止再次调用；请立即调用 reply_qq 回复用户。";
