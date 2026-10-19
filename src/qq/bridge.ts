/**
 * createQQBridge：NapCat OneBot v11 —— WebSocket 收事件，HTTP 调 API。
 * 负责：重连与心跳、自回声过滤、去重、授权 / 触发、票据持久化、按票据幂等回复。
 */
import type { DownloadHooks } from '../media/download.js';
import { inboundFromTicket } from './ticket.js';
import { downloadIncoming } from "./incoming.js";
import { EventEmitter } from "node:events";
import WebSocket from "ws";
import type {
  BridgeStatus, ChatType, InboundMessage, QQBridge, QQBridgeConfig, QQBridgeEvents,
  ReplyResult, ReplyTicketRecord,
} from "./types.js";
import { createOneBotClient, isRecord, numericId, OneBotError, stringField, type OneBotClient } from "./onebot.js";
import { isAllowed, isTriggered, normalizeMessage, validatePolicy } from "./policy.js";
import { prepareImages, type ImageSegment } from "./image.js";
import { dedupeKey, isTicketId, ticketIdFor, ReplyStore } from "./reply-store.js";

const DEFAULT_TIMEOUT_MS = 15000;
const IMAGE_TIMEOUT_MS = 30000;
const MAX_REPLY_TEXT = 4000;
const MEMORY_SEEN_LIMIT = 2000;
/** 连接持续不可用时，error 事件最多每 5 分钟报一次 */
const DOWN_REPORT_INTERVAL_MS = 5 * 60 * 1000;

/** 测试 / 运维用的内部参数，不属于对外契约。 */
interface BridgeInternals {
  downloadHooks?: DownloadHooks;
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

function idOf(value: unknown): string {
  return typeof value === "number" || (typeof value === "string" && value) ? String(value) : "";
}

/** 消息库入库范围：允许群的全部消息 + 允许用户的私聊（与是否触发无关）。 */
function inFeedScope(config: Pick<QQBridgeConfig, "allowUsers" | "allowGroups">, m: InboundMessage): boolean {
  if (m.message_type === "group") return m.group_id !== null && config.allowGroups.includes(m.group_id);
  return config.allowUsers === "*" || config.allowUsers.includes(m.user_id);
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
  private readonly scopeChains = new Map<string, Promise<void>>();
  private readonly incomingJobs = new Map<string, Promise<void>>();
  private readonly senderInflight = new Map<string, number>();
  private activeDownloads = 0;
  private readonly downloadWaiting: (() => void)[] = [];
  private readonly downloadHooks: DownloadHooks;
  private readonly downloadConcurrency: number;
  private readonly downloadDeadlineMs: number;
  private readonly seen = new Set<string>();
  private readonly locks = new Set<string>();

  constructor(config: QQBridgeConfig, internals: BridgeInternals = {}) {
    super();
    validatePolicy(config);
    if (!config.httpUrl || !config.wsUrl) throw new Error("必须配置 NapCat httpUrl 与 wsUrl。");
    if (!config.dataDir || !config.imageRoot) throw new Error("必须配置 dataDir 与 imageRoot。");
    this.config = config;
    this.downloadHooks = internals.downloadHooks ?? {};
    this.downloadConcurrency = config.incomingDownloadConcurrency ?? 2;
    this.downloadDeadlineMs = config.incomingDownloadDeadlineMs ?? 60_000;
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
    await Promise.allSettled([...this.incomingJobs.values()]);
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

    if (event.post_type === "notice") {
      this.handleNotice(event);
      return;
    }
    const message = normalizeMessage(event);
    if (!message || message.user_id === message.self_id) return; // 非消息 / 非法 / 自回声
    if (inFeedScope(this.config, message)) this.emitSafe("raw", message);
    if (!isTriggered(this.config, message)) return;

    const key = dedupeKey(message);
    if (this.seen.has(key)) return;
    this.rememberSeen(key);

    const store = this.store;
    if (!store) return;
    const id = ticketIdFor(message);
    if (store.get(id)) return;
    const attachments = (Array.isArray(event.message) ? event.message : [])
      .filter(s => isRecord(s) && s.type === 'image')
      .map(s => ({ status: 'pending' as const, deadline: Date.now() + this.downloadDeadlineMs, url: stringField(isRecord(s.data) ? s.data : {}, 'url'), file: stringField(isRecord(s.data) ? s.data : {}, 'file') }));
    message.attachments = attachments;
    const inflight = this.senderInflight.get(message.user_id) ?? 0;
    if (attachments.length && inflight >= 2) {
      message.attachments = attachments.map(a => ({ ...a, status: 'skipped', reason: '发送者下载并发超过 2' }));
    }
    const ticket = store.admit(message); // 同步事务先保存 dedupe、pending 及恢复元数据。
    if (ticket) this.enqueueIncoming(message, ticket, true);
  }

  private enqueueIncoming(message: InboundMessage, ticket: string, emit: boolean): Promise<void> {
    const existing = this.incomingJobs.get(ticket);
    if (existing) return existing;
    const scope = message.message_type === 'group' ? 'group:' + message.group_id : 'private:' + message.user_id;
    const pending = message.attachments?.some(a => a.status === 'pending');
    if (pending) this.senderInflight.set(message.user_id, (this.senderInflight.get(message.user_id) ?? 0) + 1);
    // deadline 从入队开始，包含等待 scope / 全局槽位的时间。
    const deadline = Math.min(...(message.attachments ?? []).map(a => a.deadline ?? Date.now() + this.downloadDeadlineMs), Date.now() + this.downloadDeadlineMs);
    const remaining = deadline - Date.now();
    const signal = remaining > 0 ? AbortSignal.timeout(remaining) : AbortSignal.abort(new Error('参考图下载超时'));
    const run = (this.scopeChains.get(scope) ?? Promise.resolve()).then(async () => {
      const store = this.requireStore();
      if (pending) {
        let acquired = false;
        try {
          signal.throwIfAborted();
          if (this.activeDownloads >= this.downloadConcurrency) {
            await new Promise<void>((resolve, reject) => {
              const ready = () => { signal.removeEventListener('abort', abort); acquired = true; resolve(); };
              const abort = () => { const i = this.downloadWaiting.indexOf(ready); if (i >= 0) this.downloadWaiting.splice(i, 1); reject(signal.reason); };
              signal.throwIfAborted(); this.downloadWaiting.push(ready); signal.addEventListener('abort', abort, { once: true });
            });
          } else { this.activeDownloads++; acquired = true; }
          signal.throwIfAborted();
          const event = { message: message.attachments!.map(a => ({ type: 'image', data: { url: a.url, file: a.file } })) };
          // 即使 DNS / NapCat 不响应也必须按票据截止时间释放 worker。
          const paths = await new Promise<string[]>((resolve, reject) => {
            const abort = () => reject(signal.reason);
            signal.addEventListener('abort', abort, { once: true });
            downloadIncoming(event, ticket, this.config.dataDir, this.client, signal, this.downloadHooks)
              .then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
          });
          message.images = paths;
          message.attachments = message.attachments!.map((a, i) => ({ ...a, status: 'ok', path: paths[i] }));
        } catch (err) {
          const reason = signal.aborted ? '参考图下载超时，已跳过' : '参考图处理失败：' + toError(err).message;
          message.attachments = message.attachments!.map(a => ({ ...a, status: signal.aborted ? 'skipped' : 'failed', reason }));
          if (!signal.aborted) message.image_error = reason;
          message.images = [];
        } finally {
          if (acquired) { const next = this.downloadWaiting.shift(); if (next) next(); else this.activeDownloads--; }
          const left = (this.senderInflight.get(message.user_id) ?? 1) - 1;
          if (left > 0) this.senderInflight.set(message.user_id, left); else this.senderInflight.delete(message.user_id);
        }
        store.finishAttachments(ticket, message.attachments!, message.image_error);
      }
      if (emit && this.running) this.emit('message', message, ticket);
    }).catch(err => this.emitError(toError(err)));
    this.incomingJobs.set(ticket, run); this.scopeChains.set(scope, run);
    void run.finally(() => {
      this.incomingJobs.delete(ticket);
      if (this.scopeChains.get(scope) === run) this.scopeChains.delete(scope);
    });
    return run;
  }

  async prepareIncoming(ticket: string): Promise<ReplyTicketRecord | null> {
    const rec = this.requireStore().get(ticket);
    if (rec?.attachments?.some(a => a.status === 'pending')) {
      await this.enqueueIncoming(inboundFromTicket(rec), ticket, false);
    } else await this.incomingJobs.get(ticket);
    const ready = this.requireStore().get(ticket);
    if (ready?.attachments?.some(a => a.status === 'pending')) throw new Error('参考图仍未完成，暂缓派发');
    return ready;
  }

  /** 撤回通知：group_recall / friend_recall（仅允许范围内）。 */
  private handleNotice(event: Record<string, unknown>): void {
    const messageId = idOf(event.message_id);
    if (!messageId) return;
    if (event.notice_type === "group_recall") {
      const group = idOf(event.group_id);
      if (group && this.config.allowGroups.includes(group)) this.emitSafe("recall", "group:" + group, messageId);
    } else if (event.notice_type === "friend_recall") {
      const user = idOf(event.user_id);
      if (user && (this.config.allowUsers === "*" || this.config.allowUsers.includes(user))) {
        this.emitSafe("recall", "private:" + user, messageId);
      }
    }
  }

  /** 消息库监听器出错不得影响触发与回复流程。 */
  private emitSafe(event: "raw" | "recall", ...args: unknown[]): void {
    try {
      this.emit(event, ...args);
    } catch (error) {
      this.emitError(new Error("处理 " + event + " 事件失败：" + toError(error).message));
    }
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

  async listPendingTickets(limit = 200, afterSeq = 0): Promise<ReplyTicketRecord[]> {
    return this.requireStore().listPending(limit, afterSeq);
  }

  async reply(ticket: string, text: string, imagePaths: string[] = [], opts?: { signal?: AbortSignal }): Promise<ReplyResult> {
    validateText(text);
    if (!isTicketId(ticket)) throw new Error("回复凭据无效。");
    if (this.locks.has(ticket)) throw new Error("此票据正在回复中，请勿重复发送。");
    this.locks.add(ticket);
    try {
      return await this.replyLocked(ticket, text, imagePaths, opts?.signal);
    } finally {
      this.locks.delete(ticket);
    }
  }

  private async replyLocked(ticket: string, text: string, imagePaths: string[], signal?: AbortSignal): Promise<ReplyResult> {
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

    signal?.throwIfAborted();
    const login = await this.client.call("get_login_info");
    if (stringField(login, "user_id") !== record.self_id) throw new Error("NapCat 当前登录账号与收到消息的账号不一致。");

    signal?.throwIfAborted();
    if (!store.markSending(ticket)) throw new Error("票据状态已改变，可能已在其他进程发送，请勿重发。");
    // sending 已落盘后必须完成发送；此后不传 signal，失败仍按 uncertain 处理。
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
