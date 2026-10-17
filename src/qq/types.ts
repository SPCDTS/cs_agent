/**
 * QQBridge 模块对外契约（主会话定义，实现方不得改签名；需要扩展请追加可选字段）。
 * 传输层：NapCat OneBot v11（WebSocket 收事件 + HTTP 调 API），消息格式 array 段。
 */

export type ChatType = "private" | "group";

/** 仅保留 text / at / reply 三类段的数据，其余段只保留 type，媒体永不下载。 */
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
  self_id: string;
  nickname: string;
  /** text 段拼接，其它段以 "[type]" 占位，最长 16000 字符 */
  text: string;
  /**
   * 规则分流用的文本：跳过开头的 at（任意目标）/ reply 段（及其间的纯空白 text 段）后，按 text 同一规则渲染，
   * 最长 16000 字符。用户亲手输入的 "[at]" 字样不会被跳过（只看真实段）。
   */
  route_text: string;
  truncated: boolean;
  /** 群聊中是否用真实 at 段 @ 了机器人（永不做文本匹配） */
  mentioned_self: boolean;
  segments: MessageSegment[];
}

export interface QQBridgeConfig {
  /** 例如 http://host.docker.internal:3000 */
  httpUrl: string;
  /** 例如 ws://host.docker.internal:3001 */
  wsUrl: string;
  /** NapCat Bearer token，两个端点共用 */
  token: string;
  /** "*" 或 QQ 号列表；列表中的用户在任何会话均可触发 */
  allowUsers: string[] | "*";
  /** 群号列表；群内任何成员可通过真实 @机器人 触发 */
  allowGroups: string[];
  /** 为 false 时群消息一律不触发 */
  groupMentions: boolean;
  /** HTTP 调用超时，默认 15000；带图发送可放宽到 30000 */
  timeoutMs?: number;
  /** 回复票据 / 去重状态持久化目录（SQLite 文件放在此处） */
  dataDir: string;
  /** 允许作为回复附件的图片根目录；路径必须 realpath 后落在其下 */
  imageRoot: string;
}

export type TicketStatus = "pending" | "sending" | "sent" | "uncertain";

export interface ReplyTicketRecord {
  ticket_id: string;            // sha256 hex，由 self_id:type:group_id:user_id:message_id 决定性生成
  self_id: string;
  user_id: string;
  group_id: string | null;
  message_type: ChatType;
  source_message_id: string;
  source_nickname: string;
  /** 原消息正文（normalize 后的 text），用于崩溃后无派发索引时重建处理 */
  source_text: string;
  /** 原消息的分流文本（InboundMessage.route_text）；旧库的行没有该列时为 undefined */
  source_route_text?: string;
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

export interface BridgeStatus {
  ws_connected: boolean;
  disconnect_count: number;
  self_id: string | null;
  last_event_at: string | null;
}

export interface QQBridgeEvents {
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

export interface QQBridge {
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): BridgeStatus;
  on<K extends keyof QQBridgeEvents>(event: K, listener: QQBridgeEvents[K]): this;
  off<K extends keyof QQBridgeEvents>(event: K, listener: QQBridgeEvents[K]): this;
  /**
   * 按票据回复原会话：群聊自动前置真实 at 段 + "\n"，私聊直接发；
   * 幂等：sent 返回 already_sent=true；sending/uncertain 抛错且永不自动重试。
   * text 1-4000 字符，纯文本（QQ 不渲染 Markdown）；images 0-4 张，base64:// 发送。
   */
  reply(ticket: string, text: string, imagePaths?: string[]): Promise<ReplyResult>;
  getTicket(ticket: string): Promise<ReplyTicketRecord | null>;
  /** 列出仍为 pending 的票据（按 seq 升序，最多 limit 条，默认 200）；afterSeq 为分页游标（只取 seq 更大的），供启动时与派发索引对账 */
  listPendingTickets(limit?: number, afterSeq?: number): Promise<ReplyTicketRecord[]>;
  /** 主动发送，仅供运维/测试使用，agent 工具层不暴露 */
  send(type: ChatType, targetId: string, text: string): Promise<{ message_id: string }>;
}

export interface CreateQQBridge {
  (config: QQBridgeConfig): QQBridge;
}
