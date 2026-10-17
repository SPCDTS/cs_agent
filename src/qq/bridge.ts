/**
 * createQQBridge：NapCat OneBot v11 —— WebSocket 收事件，HTTP 调 API。
 * 负责：重连与心跳、自回声过滤、去重、授权 / 触发、票据持久化、按票据幂等回复。
 */
import { EventEmitter } from "node:events";
import WebSocket from "ws";
import type {
  BridgeStatus, ChatType, QQBridge, QQBridgeConfig, QQBridgeEvents,
  ReplyResult, ReplyTicketRecord,
} from "./types.js";
import { createOneBotClient, isRecord, numericId, OneBotError, stringField, type OneBotClient } from "./onebot.js";
import { isAllowed, isTriggered, normalizeMessage, validatePolicy } from "./policy.js";
import { prepareImages, type ImageSegment } from "./image.js";
import { dedupeKey, isTicketId, ReplyStore } from "./reply-store.js";

export const DEFAULT_TIMEOUT_MS = 15000;
export const IMAGE_TIMEOUT_MS = 30000;
export const MAX_REPLY_TEXT = 4000;
const MEMORY_SEEN_LIMIT = 2000;
/** 连接持续不可用时，error 事件最多每 5 分钟报一次 */
export const DOWN_REPORT_INTERVAL_MS = 5 * 60 * 1000;

/** 测试 / 运维用的内部参数，不属于对外契约。 */
export interface BridgeInternals {
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  heartbeatMs?: number;
  /** 连接持续不可用时 error 事件的最小间隔，默认 5 分钟 */
  downReportIntervalMs?: number;
}

type OutSegment = { type: string; data: Record<string, unknown> };

/** 文本上限按 UTF-16 code unit（String.length）计；agent 侧 reply_qq 的截断用同一口径。 */
function validateText(text: string): void {
  if (typeof text !== "string" || !text.trim() || text.length > MAX_REPLY_TEXT) {
    throw new Error("消息必须是 1～4000 字符的非空文字。");
  }
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function buildMessage(type: ChatType, userId: string, text: string, images: ImageSegment[]): OutSegment[] {
  const head: OutSegment[] = type === "group"
    ? [{ type: "at", data: { qq: userId } }, { type: "text", data: { text: "\n" + text } }]
    : [{ type: "text", data: { text } }];
  return [...head, ...images];
}

class Bridge extends EventEmitter implements QQBridge {
  private readonly config: QQBridgeConfig;
  private readonly client: OneBotClient;
  private readonly timeoutMs: number;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private readonly heartbeatMs: number;
  private readonly downReportIntervalMs: number;

  private store: ReplyStore | null = null;
  private socket: WebSocket | null = null;
  private running = false;
  private connected = false;
  private failures = 0;
  /** 本轮"不可用"期间是否已报过 error，以及上次报的时间 */
  private downReported = false;
  private lastDownReportAt = 0;
  private disconnectCount = 0;
  private selfId: string | null = null;
  private lastEventAt: string | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private readonly seen = new Set<string>();
  private readonly locks = new Set<string>();

  constructor(config: QQBridgeConfig, internals: BridgeInternals = {}) {
    super();
    validatePolicy(config);
    if (!config.httpUrl || !config.wsUrl) throw new Error("必须配置 NapCat httpUrl 与 wsUrl。");
    if (!config.dataDir || !config.imageRoot) throw new Error("必须配置 dataDir 与 imageRoot。");
    this.config = config;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.client = createOneBotClient(config.httpUrl, config.token, this.timeoutMs);
    this.reconnectBaseMs = internals.reconnectBaseMs ?? 1000;
    this.reconnectMaxMs = internals.reconnectMaxMs ?? 30000;
    this.heartbeatMs = internals.heartbeatMs ?? 25000;
    this.downReportIntervalMs = internals.downReportIntervalMs ?? DOWN_REPORT_INTERVAL_MS;
  }

  // ---------- 生命周期 ----------

  async start(): Promise<void> {
    if (this.running) return;
    this.store ??= new ReplyStore(this.config.dataDir);
    this.running = true;
    try {
      const login = await this.client.call("get_login_info");
      const id = stringField(login, "user_id");
      if (id) this.selfId = id;
    } catch (error) {
      this.emitError(toError(error)); // 登录信息获取失败不阻止启动，后续从事件取 self_id
    }
    if (this.running) this.connect();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.clearHeartbeat();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.removeAllListeners();
      socket.on("error", () => undefined);
      socket.terminate();
    }
    if (this.connected) {
      this.connected = false;
      this.disconnectCount++;
      this.emit("disconnect", "stopped");
    }
    this.store?.close();
    this.store = null;
  }

  status(): BridgeStatus {
    return {
      ws_connected: this.connected,
      disconnect_count: this.disconnectCount,
      self_id: this.selfId,
      last_event_at: this.lastEventAt,
    };
  }

  // ---------- 事件订阅（类型化） ----------

  override on<K extends keyof QQBridgeEvents>(event: K, listener: QQBridgeEvents[K]): this {
    return super.on(event, listener);
  }

  override off<K extends keyof QQBridgeEvents>(event: K, listener: QQBridgeEvents[K]): this {
    return super.off(event, listener);
  }

  private emitError(error: Error): void {
    // 没有监听器时 EventEmitter 会抛出 'error'，这里吞掉以免拖垮进程
    if (this.listenerCount("error") > 0) this.emit("error", error);
  }

  /**
   * 连接类错误节流：每次"可用→不可用"只报第一次失败，持续不可用期间最多每 downReportIntervalMs 报一次，
   * 避免每次重连尝试都刷 error。
   */
  private reportConnectionError(error: Error): void {
    const now = Date.now();
    if (this.downReported && now - this.lastDownReportAt < this.downReportIntervalMs) return;
    this.downReported = true;
    this.lastDownReportAt = now;
    this.emitError(error);
  }

  // ---------- WebSocket ----------

  private connect(): void {
    if (!this.running) return;
    let socket: WebSocket;
    try {
      const headers: Record<string, string> = {};
      if (this.config.token) headers.Authorization = "Bearer " + this.config.token;
      socket = new WebSocket(this.config.wsUrl, { headers, handshakeTimeout: 10000, maxPayload: 1024 * 1024 });
    } catch (error) {
      this.reportConnectionError(toError(error));
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.on("open", () => this.onOpen(socket));
    socket.on("message", raw => this.onFrame(raw));
    socket.on("error", error => this.reportConnectionError(new Error("NapCat WebSocket 错误：" + error.message)));
    socket.on("close", (code, reason) => this.onClose(socket, code, reason.toString()));
  }

  private onOpen(socket: WebSocket): void {
    this.connected = true;
    this.failures = 0;
    this.downReported = false;
    let alive = true;
    socket.on("pong", () => { alive = true; });
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!alive) { socket.terminate(); return; }
      alive = false;
      socket.ping();
    }, this.heartbeatMs);
    this.heartbeatTimer.unref();
    this.emit("connection");
  }

  private onClose(socket: WebSocket, code: number, reason: string): void {
    if (socket !== this.socket) return;
    this.socket = null;
    this.clearHeartbeat();
    if (this.connected) {
      this.connected = false;
      this.disconnectCount++;
      const why = reason || "code " + code;
      this.emit("disconnect", why);
      // 状态变化（已连接→断开）总是报一次，开启新一轮节流
      this.downReported = false;
      this.reportConnectionError(new Error("NapCat WebSocket 连接断开：" + why));
    }
    this.scheduleReconnect();
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private scheduleReconnect(): void {
    if (!this.running) return;
    const delay = Math.min(this.reconnectBaseMs * 2 ** Math.min(this.failures++, 5), this.reconnectMaxMs);
    this.retryTimer = setTimeout(() => { this.retryTimer = null; this.connect(); }, delay);
    this.retryTimer.unref();
  }

  // ---------- 入站事件 ----------

  private onFrame(raw: WebSocket.RawData): void {
    try {
      const text = Array.isArray(raw) ? Buffer.concat(raw).toString("utf8") : Buffer.from(raw as ArrayBuffer).toString("utf8");
      this.handleEvent(JSON.parse(text) as unknown);
    } catch (error) {
      this.emitError(new Error("处理 OneBot 事件失败：" + toError(error).message));
    }
  }

  private handleEvent(event: unknown): void {
    if (!isRecord(event)) return;
    this.lastEventAt = new Date().toISOString();
    const eventSelf = event.self_id;
    if (typeof eventSelf === "number" || (typeof eventSelf === "string" && eventSelf)) this.selfId = String(eventSelf);

    const message = normalizeMessage(event);
    if (!message || message.user_id === message.self_id) return; // 非消息 / 非法 / 自回声
    if (!isTriggered(this.config, message)) return;

    const key = dedupeKey(message);
    if (this.seen.has(key)) return;
    this.rememberSeen(key);

    const store = this.store;
    if (!store) return;
    const ticket = store.admit(message);
    if (ticket === null) return; // 持久化去重：已见过，或票据早已存在（去重键被淘汰后重到）
    this.emit("message", message, ticket);
  }

  private rememberSeen(key: string): void {
    this.seen.add(key);
    if (this.seen.size > MEMORY_SEEN_LIMIT) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
  }

  // ---------- 票据回复 ----------

  async getTicket(ticket: string): Promise<ReplyTicketRecord | null> {
    return this.requireStore().get(ticket);
  }

  async listPendingTickets(limit = 200): Promise<ReplyTicketRecord[]> {
    return this.requireStore().listPending(limit);
  }

  async reply(ticket: string, text: string, imagePaths: string[] = []): Promise<ReplyResult> {
    validateText(text);
    if (!isTicketId(ticket)) throw new Error("回复凭据无效。");
    if (this.locks.has(ticket)) throw new Error("此票据正在回复中，请勿重复发送。");
    this.locks.add(ticket);
    try {
      return await this.replyLocked(ticket, text, imagePaths);
    } finally {
      this.locks.delete(ticket);
    }
  }

  private async replyLocked(ticket: string, text: string, imagePaths: string[]): Promise<ReplyResult> {
    const store = this.requireStore();
    const record = store.get(ticket);
    if (!record) throw new Error("回复凭据不存在。");
    const type = record.message_type;
    const targetId = type === "group" ? record.group_id ?? "" : record.user_id;
    if (record.status === "sent") {
      return { already_sent: true, message_id: record.reply_message_id ?? "", message_type: type, target_id: targetId };
    }
    if (record.status !== "pending") throw new Error("上一次回复结果不确定（previous result uncertain），请查看聊天记录，不要自动重发。");
    if (!isAllowed(this.config, record)) throw new Error("此发送者已不在允许回复的名单中。");

    const target = numericId(targetId);
    numericId(record.user_id);
    const images = prepareImages(imagePaths, this.config.imageRoot);

    const login = await this.client.call("get_login_info");
    if (stringField(login, "user_id") !== record.self_id) throw new Error("NapCat 当前登录账号与收到消息的账号不一致。");

    if (!store.markSending(ticket)) throw new Error("票据状态已改变，可能已在其他进程发送，请勿重发。");
    let data: unknown;
    try {
      data = await this.client.call(type === "group" ? "send_group_msg" : "send_private_msg", {
        [type === "group" ? "group_id" : "user_id"]: target,
        message: buildMessage(type, record.user_id, text, images),
      }, { sending: true, timeoutMs: images.length ? Math.max(this.timeoutMs, IMAGE_TIMEOUT_MS) : this.timeoutMs });
    } catch (error) {
      store.markUncertain(ticket);
      const detail = error instanceof OneBotError ? error.message : toError(error).message;
      throw new OneBotError("QQ 回复结果不确定（uncertain），此票据不会自动重发：" + detail, true);
    }
    const messageId = stringField(data, "message_id");
    store.markSent(ticket, messageId);
    return { already_sent: false, message_id: messageId, message_type: type, target_id: targetId };
  }

  async send(type: ChatType, targetId: string, text: string): Promise<{ message_id: string }> {
    if (type !== "private" && type !== "group") throw new Error("会话类型必须为 private 或 group。");
    const id = numericId(targetId);
    validateText(text);
    const data = await this.client.call(type === "private" ? "send_private_msg" : "send_group_msg", {
      [type === "private" ? "user_id" : "group_id"]: id,
      message: [{ type: "text", data: { text } }],
    }, { sending: true });
    return { message_id: stringField(data, "message_id") };
  }

  private requireStore(): ReplyStore {
    if (!this.store) this.store = new ReplyStore(this.config.dataDir);
    return this.store;
  }
}

/** 创建 QQBridge 实例；调用 start() 后开始连接 NapCat。 */
export function createQQBridge(config: QQBridgeConfig, internals?: BridgeInternals): QQBridge {
  return new Bridge(config, internals);
}

