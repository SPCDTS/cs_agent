/**
 * 通道公共契约；字段名与取值沿用现有票据和消息库格式。
 */

export type IncomingAttachment = { status: 'pending' | 'ok' | 'skipped' | 'failed'; url?: string; file?: string; path?: string; reason?: string; deadline?: number };

export type ChatType = "private" | "group";

/** 仅保留 text / at / reply 三类段的数据，其余段只保留 type；触发消息的图片由 bridge 从原始事件单独下载。 */
export type MessageSegment =
  | { type: "text"; data: { text: string } }
  | { type: "at"; data: { qq: string } }
  | { type: "reply"; data: { id: string } }
  | { type: string; data: Record<string, never> };

export interface InboundMessage {
  message_id: string;
  time: number;
  message_type: ChatType;
  user_id: string;
  group_id: string | null;
  group_name?: string;
  self_id: string;
  nickname: string;
  /** text 段拼接，其它段以 "[type]" 占位，最长 16000 字符 */
  text: string;
  /**
   * 规则分流用的文本：跳过开头的 at（任意目标）/ reply 段（及其间的纯空白 text 段）后，图片段跳过，其余按 text 同一规则渲染，
   * 最长 16000 字符。用户亲手输入的 "[at]" 字样不会被跳过（只看真实段）。
   */
  route_text: string;
  truncated: boolean;
  /** 群聊中是否用真实 at 段 @ 了机器人（永不做文本匹配） */
  mentioned_self: boolean;
  segments: MessageSegment[];
  /** 本票据已下载并校验的参考图绝对路径。 */
  images: string[];
  image_error?: string;
  attachments?: IncomingAttachment[];
}

export type TicketStatus = "pending" | "sending" | "sent" | "uncertain";

/** 定时出站票据的创建者与目的地分开保存；self_id 由 Channel 查询并绑定。 */
export interface OutboundTicket {
  message_type: ChatType;
  target_id: string;
  origin: "scheduled";
  user_id: string;
}

export interface ReplyTicketRecord {
  /** 旧票据缺省为入站消息。 */
  origin?: "message" | "scheduled";
  /** 定时私聊的目标可能不同于创建者。 */
  target_id?: string;
  ticket_id: string;            // 入站为 sha256 hex；定时为 run_ + fire_key 的 sha256 前 40 位
  self_id: string;
  user_id: string;
  group_id: string | null;
  message_type: ChatType;
  source_message_id: string;
  source_nickname: string;
  group_name?: string;
  /** 原消息正文（normalize 后的 text），用于崩溃后无派发索引时重建处理 */
  source_text: string;
  /** 原消息的分流文本（InboundMessage.route_text）；旧库的行没有该列时为 undefined */
  source_route_text?: string;
  source_images?: string[];
  attachments?: IncomingAttachment[];
  source_image_error?: string;
  created_at: string;
  /** admit 顺序号（票据表 rowid，与 created_at 同一事务分配，单调递增）：派发与崩溃恢复的唯一排序键 */
  seq: number;
  status: TicketStatus;
  attempted_at?: string;
  sent_at?: string;
  reply_message_id?: string;
}

export interface ReplyResult {
  already_sent: boolean;
  message_id: string;
  message_type: ChatType;
  target_id: string;
}

export interface ChannelStatus {
  ws_connected: boolean;
  disconnect_count: number;
  self_id: string | null;
  last_event_at: string | null;
}

export interface ChannelEvents {
  /** 仅投递已通过授权与触发规则的消息；ticket 已持久化为 pending */
  message: (message: InboundMessage, ticket: string) => void;
  /**
   * 允许范围内的每条入站消息（允许群的全部消息 + 允许用户的私聊），不论是否触发；
   * 不含机器人自回声。先于同一条消息的 message 事件发出。供本地消息库入库。
   */
  raw: (message: InboundMessage) => void;
  /** 允许范围内的撤回通知（OneBot notice/group_recall、friend_recall）；scope 为 group:<id> / private:<qq> */
  recall: (scope: string, message_id: string) => void;
  connection: () => void;
  disconnect: (reason: string) => void;
  error: (error: Error) => void;
}

export interface Channel {
  openOutbound(ticket: string, target: OutboundTicket): Promise<ReplyTicketRecord>;
  readonly outbox: import("./outbox.js").OutboxStore;
  send(key: string, target: { message_type: ChatType; target_id: string }, text: string, images?: string[],
    opts?: { mention?: string; signal?: AbortSignal }): Promise<ReplyResult>;
  settleTicket(ticket: string): Promise<void>;
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): ChannelStatus;
  on<K extends keyof ChannelEvents>(event: K, listener: ChannelEvents[K]): this;
  off<K extends keyof ChannelEvents>(event: K, listener: ChannelEvents[K]): this;
  /**
   * 按票据回复原会话：群聊自动前置真实 at 段 + "\n"，私聊直接发；
   * 幂等：sent 返回 already_sent=true；sending/uncertain 抛错且永不自动重试。
   * text 1-4000 字符，纯文本（QQ 不渲染 Markdown）；images 0-4 张，base64:// 发送。
   */
  reply(ticket: string, text: string, imagePaths?: string[], opts?: { signal?: AbortSignal }): Promise<ReplyResult>;
  /** 文件作为独立 QQ 消息发送；调用者负责持久化幂等状态。 */
  uploadFile(type: ChatType, targetId: string, file: Buffer, name: string): Promise<{ file_id: string }>;
  prepareIncoming?(ticket: string): Promise<ReplyTicketRecord | null>;
  getTicket(ticket: string): Promise<ReplyTicketRecord | null>;
  /** 列出仍为 pending 的票据（按 seq 升序，最多 limit 条，默认 200）；afterSeq 为分页游标（只取 seq 更大的），供启动时与派发索引对账 */
  listPendingTickets(limit?: number, afterSeq?: number): Promise<ReplyTicketRecord[]>;
  /** 当前处于熔断的发送 scope（group:<id> / private:<qq> / global）；不支持发送规则的通道缺省。 */
  sendBreakers?(): import("./send-rules.js").SendBreaker[];
  /** 手动解除熔断；返回 false 表示该 scope 没有处于熔断。 */
  resetSendBreaker?(scope: string): boolean;
  /** 主动发送，仅供运维/测试使用，agent 工具层不暴露；不受发送规则约束 */
  sendOps(type: ChatType, targetId: string, text: string): Promise<{ message_id: string }>;
  /** 取远端原消息；不存在返回 null。 */
  fetchMessage(messageId: string, opts: { signal: AbortSignal; timeoutMs?: number }): Promise<RemoteMessage | null>;
  /** 只读列出群与好友；调用方负责访问范围校验。 */
  listChats(opts: { signal: AbortSignal }): Promise<{
    groups: { group_id: string; name: string; member_count?: number }[];
    friends: { user_id: string; nickname: string; remark?: string }[];
  }>;
  /** 图片直链失效时换新地址；拿不到返回 undefined。 */
  refreshImageUrl(file: string, opts: { signal: AbortSignal }): Promise<string | undefined>;
}

/** 会话标识；本步仅使用 qq，scope 仍为 group:<id> / private:<qq>。 */
export type ConversationRef = { channel: string; scope: string };

/** 适配器归一化协议字段；会话范围核验仍由调用方负责。 */
export interface RemoteMessage {
  message_type: string;
  /** 远端未给出时为空字符串。 */
  message_id: string;
  group_id: string;
  /** user_id 或 sender.user_id。 */
  sender_id: string;
  /** sender.user_id 存在且与归一化后的发送者不一致。 */
  sender_conflict: boolean;
  /** 实际出现的可选收件人字段及其字符串值。 */
  recipient_fields: Record<string, string>;
  has_nonempty_group_field: boolean;
  /** rendered 是单段的原始文本渲染结果。 */
  segments: { type: string; rendered: string; image?: { url: string; file: string } }[];
}

/** 主进程从 Channel 票据记录构造，不接受模型参数中的身份。 */
export interface TurnIdentity { actor: string; actorIsOwner: boolean }
