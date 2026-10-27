/**
 * 通道公共契约；字段名与取值沿用 Inbox 与消息库格式。
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
  /** 本条输入已下载并校验的参考图绝对路径。 */
  images: string[];
  image_error?: string;
  attachments?: IncomingAttachment[];
}

/** Outbox 行与附件的发送状态（docs/ARCHITECTURE.md §3.2）。 */
export type SendStatus = "pending" | "sending" | "sent" | "uncertain";

/** 输入种类：QQ 消息或定时任务到点（§2.2、§6）。 */
export type InboundKind = "user" | "scheduled" | "event";
/** queued 未送达后端 → delivered 后端已收下 → done 所在回合结束（§2.2）。 */
export type InboundState = "queued" | "delivered" | "done";

/** Inbox 持久化的一条输入；键为确定性入站键（定时为 run_ 键）。 */
export interface InboundRecord {
  key: string;
  kind: InboundKind;
  event_source?: string;
  event_count?: number;
  /** 合并事件的去重键，与入站行同事务持久化。 */
  event_keys?: string[];
  /** 到达顺序号（表 rowid） */
  seq: number;
  /** 本会话的投递地址：group:<id> / private:<qq> */
  scope: string;
  /** 会话线程键：owner / group:<id> / private:<qq> */
  thread_key: string;
  /** 收到消息的机器人账号；定时输入为空 */
  self_id: string;
  /** 发送者；定时输入为创建者 */
  user_id: string;
  group_id: string | null;
  group_name?: string;
  message_type: ChatType;
  /** 入站消息 id；定时输入为空 */
  message_id: string;
  nickname: string;
  text: string;
  route_text: string;
  /** 入站消息引用的 message_id */
  reply_to?: string;
  /** unix 秒 */
  time: number;
  images: string[];
  attachments: IncomingAttachment[];
  image_error?: string;
  created_at: string;
  state: InboundState;
  turn_id?: string;
}

/** 定时输入：到点由执行侧写入（§6）；重放保持首次内容。 */
export interface ScheduledInput {
  key: string;
  scope: string;
  thread_key: string;
  creator: string;
  text: string;
  time: number;
}

export interface EventInput {
  key: string;
  owner: string;
  source: string;
  count: number;
  eventKeys: string[];
  text: string;
  time: number;
}

/** Inbox 的持久化契约；agent 不依赖 QQ 的 SQLite 实现。 */
export interface InboxStore {
  getInbound(key: string): InboundRecord | null;
  /** 按到达顺序列出某状态的输入；afterSeq 为分页游标 */
  listInbound(state: InboundState, limit?: number, afterSeq?: number): InboundRecord[];
  /** 会话最近一条输入（唤醒回合取发送地址与引用） */
  latestInbound(threadKey: string): InboundRecord | null;
  /** 会话在 beforeSeq 之前、回合 id 以 turnPrefix 开头的最近一条用户输入（某后端上次看到哪里） */
  lastUserInput(threadKey: string, turnPrefix: string, beforeSeq: number): InboundRecord | null;
  /** 某回合的全部输入（含插话），按到达顺序 */
  listInboundByTurn(turnId: string): InboundRecord[];
  markInbound(keys: readonly string[], state: InboundState, turnId?: string): void;
  openScheduledInput(input: ScheduledInput): InboundRecord;
  openEventInput(input: EventInput): InboundRecord;
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
  /** 仅投递已通过授权与触发规则的消息；key 为已持久化（queued）的入站键，附件已下载完毕 */
  message: (message: InboundMessage, key: string) => void;
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
  readonly outbox: import("./outbox.js").OutboxStore;
  readonly inbox: InboxStore;
  send(key: string, target: { message_type: ChatType; target_id: string }, text: string, images?: string[],
    opts?: { mention?: string; signal?: AbortSignal }): Promise<ReplyResult>;
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): ChannelStatus;
  on<K extends keyof ChannelEvents>(event: K, listener: ChannelEvents[K]): this;
  off<K extends keyof ChannelEvents>(event: K, listener: ChannelEvents[K]): this;
  /** 文件作为独立 QQ 消息发送；调用者负责持久化幂等状态。 */
  uploadFile(type: ChatType, targetId: string, file: Buffer, name: string): Promise<{ file_id: string }>;
  /** 等待入站附件下载完成（恢复时补下载），返回最新的输入记录。 */
  prepareIncoming?(key: string): Promise<InboundRecord | null>;
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

/**
 * 回合绑定的人（§5.1）：kind 为此人以什么身份驱动回合（user 发送者 / scheduled 定时创建者），
 * owner 为快照时此人是否 owner（继承时只降不升：当前配置也须仍是 owner）。
 */
export type RunPerson = { kind: "user" | "scheduled" | "event"; person: string; owner: boolean };

/**
 * 本轮身份（§5.1）：user 为发送者，scheduled 为创建者，wake 为没有新输入的唤醒回合。
 * 唤醒回合的 inherited 为确证继承的人（派出子 agent 那一轮的人，随汇报带回）；缺省表示只有会话基础权限。
 * 权限一律经 `runRights`（src/agent/host/identity.ts）求出，不在各处按 kind 自行判断。
 */
export type TurnIdentity =
  | { kind: "user"; sender: string }
  | { kind: "scheduled"; creator: string }
  | { kind: "event"; source: string; creator: string }
  | { kind: "wake"; inherited?: RunPerson };

/**
 * 工具调用时由主进程从会话宿主求出的绑定（§3.1、§5.1）：身份、发送地址与本轮输入，模型参数不能覆盖。
 * 子 agent 会话固定为没有继承的 wake 身份（会话基础权限）。
 */
export interface TurnBinding {
  threadKey: string;
  turnId?: string;
  identity: TurnIdentity;
  /** 本会话的投递地址：group:<id> / private:<qq> */
  scope: string;
  /** 本轮最后一条输入（唤醒回合为会话最近一条）：@、引用与登录号校验 */
  inputKey?: string;
  /** 本轮全部输入键（附件目录） */
  inputs: readonly string[];
}
