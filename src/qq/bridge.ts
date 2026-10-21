/**
 * createQQBridge：NapCat OneBot v11 —— WebSocket 收事件，HTTP 调 API。
 * 负责：重连与心跳、自回声过滤、去重、授权 / 触发、票据持久化、按票据幂等回复。
 */
import { log } from "../shared/log.js";
import { trace } from "../shared/trace.js";
import { attachmentName } from "../media/attach.js";
import type { DownloadHooks } from '../media/download.js';
import { inboundFromTicket, ticketTarget } from '../channel/ticket.js';
import { downloadIncoming } from "./incoming.js";
import { EventEmitter } from "node:events";
import WebSocket from "ws";
import type {
  Channel, ChannelStatus, ChatType, InboundMessage, ChannelEvents,
  RemoteMessage, ReplyResult, ReplyTicketRecord, OutboundTicket,
} from "../channel/types.js";
import type { QQBridge, QQBridgeConfig } from "./types.js";
import { createOneBotClient, isRecord, numericId, isValidId, OneBotError, stringField, type OneBotClient } from "./onebot.js";
import { hasUsableContent, isAllowed, isTriggered, messageSegmentTypes, normalizeMessage, renderText, validatePolicy } from "./policy.js";
import { prepareImages, type ImageSegment } from "./image.js";
import { dedupeKey, isTicketId, ticketIdFor, ReplyStore } from "./reply-store.js";

const GROUP_NAME_TTL_MS = 6 * 60 * 60_000;
const GROUP_NAME_BACKOFF_MS = 60_000;
const GROUP_NAME_TIMEOUT_MS = 1500;

const DEFAULT_TIMEOUT_MS = 15000;
const IMAGE_TIMEOUT_MS = 30000;
const MAX_REPLY_TEXT = 4000;
const MEMORY_SEEN_LIMIT = 2000;
/** 连接持续不可用时，error 事件最多每 5 分钟报一次 */
const DOWN_REPORT_INTERVAL_MS = 5 * 60 * 1000;

/** 测试 / 运维用的内部参数，不属于对外契约。 */
interface BridgeInternals {
  client?: OneBotClient;
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
function inFeedScope(config: Pick<QQBridgeConfig, "allowUsers" | "allowGroups" | "owners">, m: InboundMessage): boolean {
  if (m.message_type === "group") return m.group_id !== null && config.allowGroups.includes(m.group_id);
  return isAllowed(config, m);
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function buildMessage(type: ChatType, userId: string, text: string, images: ImageSegment[]): OutSegment[] {
  const head: OutSegment[] = type === "group" && userId
    ? [{ type: "at", data: { qq: userId } }, { type: "text", data: { text: "\n" + text } }]
    : [{ type: "text", data: { text } }];
  return [...head, ...images];
}

class Bridge extends EventEmitter implements Channel {
  readonly name = "qq";
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
  private readonly groupNames = new Map<string, { name?: string; expires: number }>();
  private readonly groupNameJobs = new Map<string, Promise<string | undefined>>();
  private readonly rawJobs = new Map<string, Promise<void>>();
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
    this.client = internals.client ?? createOneBotClient(config.httpUrl, config.token, this.timeoutMs);
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

  status(): ChannelStatus {
    return {
      ws_connected: this.connected,
      disconnect_count: this.disconnectCount,
      self_id: this.selfId,
      last_event_at: this.lastEventAt,
    };
  }

  /** 取消等待时忽略迟到的 OneBot 响应；HTTP 请求沿用客户端超时。 */
  private remoteCall(action: string, params: Record<string, unknown>, opts: { signal: AbortSignal; timeoutMs?: number }): Promise<unknown> {
    opts.signal.throwIfAborted();
    const work = this.client.call(action, params, opts.timeoutMs === undefined ? undefined : { timeoutMs: opts.timeoutMs });
    const { signal } = opts;
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
      if (signal.aborted) abort();
    });
  }

  async fetchMessage(messageId: string, opts: { signal: AbortSignal; timeoutMs?: number }): Promise<RemoteMessage | null> {
    const remote = await this.remoteCall("get_msg", { message_id: messageId }, opts);
    if (!isRecord(remote)) return null;
    const sender = stringField(remote, "user_id") || stringField(remote.sender, "user_id");
    const recipient_fields: Record<string, string> = {};
    // NapCat 各版本的可选收件人字段；保留实际出现的字段，包括无效值转成的空字符串。
    for (const field of ["target_id", "peer_id", "peer_uid", "peerId", "peerUid", "recipient_id", "receiver_id",
      "target_user_id", "target_group_id"]) {
      if (Object.hasOwn(remote, field)) recipient_fields[field] = stringField(remote, field);
    }
    const segments = Array.isArray(remote.message) ? remote.message.filter(isRecord) : [];
    return {
      message_type: typeof remote.message_type === "string" ? remote.message_type : "",
      message_id: stringField(remote, "message_id"),
      group_id: stringField(remote, "group_id"),
      sender_id: sender,
      sender_conflict: !!stringField(remote.sender, "user_id") && stringField(remote.sender, "user_id") !== sender,
      recipient_fields,
      has_nonempty_group_field: Object.hasOwn(remote, "group_id") && ![null, undefined, 0, "0", ""].includes(remote.group_id as never),
      segments: segments.map(segment => {
        const normalized: RemoteMessage["segments"][number] = {
          type: typeof segment.type === "string" ? segment.type : "unknown",
          rendered: renderText([segment]),
        };
        if (segment.type === "image") {
          const data = isRecord(segment.data) ? segment.data : {};
          const file = stringField(data, "file");
          const url = stringField(data, "url") || (/^https?:\/\//i.test(file) ? file : "");
          normalized.image = { url, file };
        }
        return normalized;
      }),
    };
  }

  async listChats(opts: { signal: AbortSignal }): ReturnType<Channel["listChats"]> {
    const [groupList, friendList] = await Promise.all([
      this.remoteCall("get_group_list", {}, opts), this.remoteCall("get_friend_list", {}, opts),
    ]);
    opts.signal.throwIfAborted();
    if (!Array.isArray(groupList) || !Array.isArray(friendList)) throw new Error("会话列表返回格式错误");
    const groups = groupList.filter(isRecord).flatMap(row => {
      const group_id = stringField(row, "group_id");
      if (!isValidId(group_id)) return [];
      const name = typeof row.group_name === "string" ? row.group_name : "";
      if (name) this.groupNames.set(group_id, { name, expires: Date.now() + GROUP_NAME_TTL_MS });
      const count = typeof row.member_count === "number" || typeof row.member_count === "string" && row.member_count.trim()
        ? Number(row.member_count) : NaN;
      return [{ group_id, name, ...(Number.isSafeInteger(count) && count >= 0 ? { member_count: count } : {}) }];
    });
    const friends = friendList.filter(isRecord).flatMap(row => {
      const user_id = stringField(row, "user_id");
      if (!isValidId(user_id)) return [];
      return [{ user_id, nickname: typeof row.nickname === "string" ? row.nickname : "",
        ...(typeof row.remark === "string" ? { remark: row.remark } : {}) }];
    });
    return { groups, friends };
  }

  private nameMessage(message: InboundMessage): Promise<void> | undefined {
    if (message.message_type !== "group" || !message.group_id) return;
    const groupId = message.group_id, cached = this.groupNames.get(groupId);
    if (cached && cached.expires > Date.now()) { message.group_name = cached.name; return; }
    let job = this.groupNameJobs.get(groupId);
    if (!job) {
      const entry = { name: cached?.name, expires: 0 }; // 刷新失败时沿用旧群名
      this.groupNames.set(groupId, entry);
      const control = new AbortController();
      const timer = setTimeout(() => control.abort(new Error("群名查询超时")), GROUP_NAME_TIMEOUT_MS);
      timer.unref();
      job = this.remoteCall("get_group_info", { group_id: numericId(groupId) }, { signal: control.signal, timeoutMs: GROUP_NAME_TIMEOUT_MS })
        .then(info => {
          const name = isRecord(info) && typeof info.group_name === "string" ? info.group_name : "";
          if (!name) throw new Error("群名为空");
          if (this.groupNames.get(groupId) === entry) { entry.name = name; entry.expires = Date.now() + GROUP_NAME_TTL_MS; }
          return this.groupNames.get(groupId)?.name;
        }).catch(() => {
          if (this.groupNames.get(groupId) === entry) entry.expires = Date.now() + GROUP_NAME_BACKOFF_MS;
          return this.groupNames.get(groupId)?.name;
        }).finally(() => { clearTimeout(timer); this.groupNameJobs.delete(groupId); });
      this.groupNameJobs.set(groupId, job);
    }
    return job.then(name => { message.group_name = name; });
  }

  async refreshImageUrl(file: string, opts: { signal: AbortSignal }): Promise<string | undefined> {
    const info = await this.remoteCall("get_image", { file }, { signal: opts.signal });
    return stringField(info, "url") || undefined;
  }

  // ---------- 事件订阅（类型化） ----------

  override on<K extends keyof ChannelEvents>(event: K, listener: ChannelEvents[K]): this {
    return super.on(event, listener);
  }

  override off<K extends keyof ChannelEvents>(event: K, listener: ChannelEvents[K]): this {
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
    const feed = inFeedScope(this.config, message), triggered = isTriggered(this.config, message);
    const named = feed || triggered ? this.nameMessage(message) : undefined;
    if (feed) {
      if (named) {
        const key = "group:" + message.group_id + ":" + message.message_id;
        const raw = named.then(() => { if (this.running) this.emitSafe("raw", message); });
        this.rawJobs.set(key, raw);
        void raw.finally(() => { if (this.rawJobs.get(key) === raw) this.rawJobs.delete(key); });
      } else this.emitSafe("raw", message);
    }
    if (!triggered) return;

    const key = dedupeKey(message);
    if (this.seen.has(key)) return;
    this.rememberSeen(key);

    const store = this.store;
    if (!store) return;
    const id = ticketIdFor(message);
    if (store.get(id)) return;
    const scope = message.message_type === "group" ? "group:" + message.group_id : "private:" + message.user_id;
    const detail = { segments: messageSegmentTypes(event), message_id: message.message_id, sender: message.nickname };
    trace.event(id, "received", { scope, detail: { text: message.text, ...detail } });
    const attachments = (Array.isArray(event.message) ? event.message : [])
      .filter(s => isRecord(s) && s.type === 'image')
      .map(s => ({ status: 'pending' as const, deadline: Date.now() + this.downloadDeadlineMs, url: stringField(isRecord(s.data) ? s.data : {}, 'url'), file: stringField(isRecord(s.data) ? s.data : {}, 'file') }));
    message.attachments = attachments;
    if (!hasUsableContent(message)) {
      log.info("inbound ignored: empty content", detail);
      trace.event(id, "ignored", { scope, detail: { ...detail, reason: "empty content" } });
      return;
    }
    const inflight = this.senderInflight.get(message.user_id) ?? 0;
    if (attachments.length && inflight >= 2) {
      message.attachments = attachments.map(a => ({ ...a, status: 'skipped', reason: '发送者下载并发超过 2' }));
    }
    const ticket = store.admit(message); // 同步事务先保存 dedupe、pending 及恢复元数据。
    if (ticket) this.enqueueIncoming(message, ticket, true, named);
  }

  private enqueueIncoming(message: InboundMessage, ticket: string, emit: boolean, named?: Promise<void>): Promise<void> {
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
      if (named) {
        await named;
        if (message.group_name) store.setGroupName(ticket, message.group_name);
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
      if (group && this.config.allowGroups.includes(group)) {
        // 群名查询异步化后，撤回仍须排在原消息入库之后。
        const raw = this.rawJobs.get("group:" + group + ":" + messageId);
        if (raw) void raw.then(() => { if (this.running) this.emitSafe("recall", "group:" + group, messageId); });
        else this.emitSafe("recall", "group:" + group, messageId);
      }
    } else if (event.notice_type === "friend_recall") {
      const user = idOf(event.user_id);
      if (user && isAllowed(this.config, { message_type: "private", user_id: user, group_id: null })) {
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

  async openOutbound(ticket: string, target: OutboundTicket): Promise<ReplyTicketRecord> {
    const login = await this.client.call("get_login_info");
    const self_id = stringField(login, "user_id");
    numericId(self_id);
    return this.requireStore().openOutbound(ticket, { ...target, self_id });
  }

  async getTicket(ticket: string): Promise<ReplyTicketRecord | null> {
    return this.requireStore().get(ticket);
  }

  async listPendingTickets(limit = 200, afterSeq = 0): Promise<ReplyTicketRecord[]> {
    return this.requireStore().listPending(limit, afterSeq);
  }

  get outbox() { return this.requireStore(); }

  async settleTicket(ticket: string): Promise<void> { this.requireStore().settleTicket(ticket); }

  /** 发送前共享票据授权、登录号检查和消息构建；sending 后绝不自动重试。 */
  async send(key: string, target: { message_type: ChatType; target_id: string }, text: string, imagePaths: string[] = [],
    opts?: { mention?: string; signal?: AbortSignal }): Promise<ReplyResult> {
    const store = this.requireStore(), row = store.getOutbox(key);
    if (!row || row.message_type !== target.message_type || row.target_id !== target.target_id) throw new Error("Outbox 目标不一致");
    const result = { message_type: row.message_type, target_id: row.target_id };
    if (row.status === "sent") return { ...result, already_sent: true, message_id: row.message_id ?? "" };
    if (row.status !== "pending") throw new Error("上一次发送结果不确定（uncertain），不要自动重发");
    const record = store.get(row.ticket);
    if (!record || record.status !== "pending") throw new Error("回合票据已结束或不存在");
    // 目标由网关授权后写入 Outbox；通道仍校验来源允许名单、登录号和不可变的行内容。
    const sameSource = target.message_type === record.message_type && target.target_id === ticketTarget(record);
    if (target.message_type === "group" && !this.config.allowGroups.includes(target.target_id)) {
      throw new Error("目标群不在 QQ_ALLOW_GROUPS 允许名单中");
    }
    if (opts?.mention && (record.origin === "scheduled" || !sameSource || record.message_type !== "group" || opts.mention !== record.user_id)) throw new Error("定时或主动发送不能 @，回复只能 @ 本轮发送者");
    if (text !== row.text || JSON.stringify(imagePaths) !== JSON.stringify(row.images) || (opts?.mention ?? null) !== row.mention_user_id) throw new Error("Outbox 内容不一致");
    validateText(text);
    const images = prepareImages(imagePaths, this.config.imageRoot);
    await this.checkReplyIdentity(record, opts?.signal);
    opts?.signal?.throwIfAborted();
    if (!store.markOutboxSending(key)) throw new Error("发送状态已改变，结果不确定，不重发");
    try {
      const data = await this.client.call(target.message_type === "group" ? "send_group_msg" : "send_private_msg", {
        [target.message_type === "group" ? "group_id" : "user_id"]: numericId(target.target_id),
        message: buildMessage(target.message_type, store.getOutbox(key)!.mention_user_id ?? "", text, images),
      }, { sending: true, timeoutMs: images.length ? Math.max(this.timeoutMs, IMAGE_TIMEOUT_MS) : this.timeoutMs });
      const messageId = stringField(data, "message_id");
      if (!messageId) throw new Error("发送缺少 message_id");
      store.markOutboxSent(key, messageId);
      return { ...result, already_sent: false, message_id: messageId };
    } catch (error) { store.markOutboxUncertain(key); throw new OneBotError("QQ 发送结果不确定（uncertain），不会自动重发：" + toError(error).message, true); }
  }

  private async checkReplyIdentity(record: ReplyTicketRecord, signal?: AbortSignal): Promise<void> {
    if (!isAllowed(this.config, record.origin === "scheduled" && record.message_type === "private"
      ? { ...record, user_id: ticketTarget(record) } : record)) throw new Error("此发送者已不在允许回复的名单中。");
    numericId(record.user_id);
    signal?.throwIfAborted();
    const login = await this.client.call("get_login_info");
    if (stringField(login, "user_id") !== record.self_id) throw new Error("NapCat 当前登录账号与收到消息的账号不一致。");
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
    const targetId = ticketTarget(record);
    if (record.status === "sent") {
      return { already_sent: true, message_id: record.reply_message_id ?? "", message_type: type, target_id: targetId };
    }
    if (record.status !== "pending") throw new Error("上一次回复结果不确定（previous result uncertain），请查看聊天记录，不要自动重发。");
    const target = numericId(targetId);
    numericId(record.user_id);
    const images = prepareImages(imagePaths, this.config.imageRoot);

    await this.checkReplyIdentity(record, signal);

    signal?.throwIfAborted();
    if (!store.markSending(ticket)) throw new Error("票据状态已改变，可能已在其他进程发送，请勿重发。");
    // sending 已落盘后必须完成发送；此后不传 signal，失败仍按 uncertain 处理。
    let data: unknown;
    try {
      data = await this.client.call(type === "group" ? "send_group_msg" : "send_private_msg", {
        [type === "group" ? "group_id" : "user_id"]: target,
        message: buildMessage(type, record.origin === "scheduled" ? "" : record.user_id, text, images),
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

  async uploadFile(type: ChatType, targetId: string, file: Buffer, name: string): Promise<{ file_id: string }> {
    if (type !== "private" && type !== "group") throw new Error("会话类型必须为 private 或 group。");
    if (!Buffer.isBuffer(file) || !file.length) throw new Error("文件不能为空");
    const timeoutMs = Math.min(120_000, Math.max(this.timeoutMs, IMAGE_TIMEOUT_MS) + Math.ceil(file.length / 1024 / 1024) * 2000);
    const data = await this.client.call(type === "private" ? "upload_private_file" : "upload_group_file", {
      [type === "private" ? "user_id" : "group_id"]: numericId(targetId),
      file: "base64://" + file.toString("base64"), name: attachmentName(name),
    }, { sending: true, timeoutMs });
    const file_id = stringField(data, "file_id");
    if (!file_id) throw new OneBotError("文件上传缺少 file_id，结果不确定，不要重试", true);
    return { file_id };
  }

  async sendOps(type: ChatType, targetId: string, text: string): Promise<{ message_id: string }> {
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
