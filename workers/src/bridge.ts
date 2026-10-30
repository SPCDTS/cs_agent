import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import { channelDown, parseFrame, type SendReceipt } from "./onebot";
import { cleanName, id, inboundKey, isAllowed, isRecord, isTriggered, policyFrom, scopeOf, threadKey, type InboundInput, type Target } from "./policy";
import { SendRules } from "./send-rules";
import { effectiveSettings, type SettingsSnapshot } from "./settings";

type Attachment = { id: string; active: boolean };
type Pending = { socket: WebSocket; resolve: (data: unknown) => void; reject: (error: Error) => void };
type GroupName = { name: string; expires: number };

export class BridgeDO extends DurableObject<Env> {
  // P1a 的 echo 仍只在内存中；发帧后失联属于结果不确定，不能自动重发。
  private readonly pending = new Map<string, Pending>();
  private readonly deliveries = new Map<string, Promise<void>>();
  private readonly groupQueries = new Map<string, Promise<string | undefined>>();
  private readonly rules = new SendRules(this.ctx.storage);
  // 设置只在内存缓存；面板保存后经 reloadSettings 推送，DO 重建时重新拉取。
  private settingsLoad?: Promise<SettingsSnapshot>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS seen (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS threads (key TEXT PRIMARY KEY, seen_at INTEGER NOT NULL);
    `);
  }

  private activeSocket(): WebSocket | undefined {
    return this.ctx.getWebSockets().find(socket => {
      const attachment: Attachment | null = socket.deserializeAttachment();
      return attachment?.active === true && socket.readyState === WebSocket.OPEN;
    });
  }

  override fetch(request: Request): Response {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("websocket required", { status: 426 });
    for (const socket of this.ctx.getWebSockets()) {
      this.disconnect(socket);
      socket.close(1000, "replaced");
    }
    const { 0: client, 1: server } = new WebSocketPair();
    server.serializeAttachment({ id: crypto.randomUUID(), active: true } satisfies Attachment);
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(socket: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    // 已被新连接取代的 socket 可能还有排队帧，不能再投递或结算 API。
    if (socket !== this.activeSocket()) return;
    const frame = parseFrame(raw);
    if (!frame) return;
    switch (frame.kind) {
      case "meta":
        if (frame.selfId) await this.ctx.storage.put("selfId", frame.selfId);
        return;
      case "response": {
        const pending = this.pending.get(frame.echo);
        if (!pending || pending.socket !== socket) return;
        if (frame.ok) pending.resolve(frame.data);
        else pending.reject(new Error("onebot_failed: API 未成功，请先核实，不要重试"));
        return;
      }
      case "message": {
        const input = frame.input, policy = policyFrom(this.env, effectiveSettings(this.env, (await this.loadSettings()).overrides));
        if (!isAllowed(policy, input)) {
          await this.ctx.storage.transaction(async tx => {
            await tx.put("ignored", (await tx.get<number>("ignored") ?? 0) + 1);
          });
          return;
        }
        const key = inboundKey(input), thread = threadKey(policy, input);
        const inserted = this.ctx.storage.transactionSync(() => {
          const added = this.ctx.storage.sql.exec("INSERT OR IGNORE INTO seen (key) VALUES (?) RETURNING key", key).toArray().length > 0;
          this.ctx.storage.sql.exec("DELETE FROM seen WHERE id NOT IN (SELECT id FROM seen ORDER BY id DESC LIMIT 5000)");
          this.ctx.storage.sql.exec("INSERT INTO threads (key, seen_at) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET seen_at=excluded.seen_at", thread, Date.now());
          return added;
        });
        if (!inserted) return;
        // 按会话串行入库与提交；群名查询不能阻塞 WS 回执，也不能改变消息到达顺序。
        const delivery = (this.deliveries.get(thread) ?? Promise.resolve()).then(async () => {
          if (input.target.kind === "group") input.scopeName = await this.groupName(input.target.groupId);
          const target = this.env.THREAD.getByName(thread);
          const { repliedToSelf } = await target.ingest(input);
          if (input.text.trim() && isTriggered(policy, input, repliedToSelf)) {
            this.ctx.waitUntil(target.submit(input).catch(() => {
              console.error({ event: "submit_failed", messageId: input.messageId, length: input.text.length });
            }));
          }
        }).catch(() => {
          this.ctx.storage.sql.exec("DELETE FROM seen WHERE key = ?", key);
          console.error({ event: "ingest_failed", messageId: input.messageId, length: input.text.length });
        });
        this.deliveries.set(thread, delivery);
        this.ctx.waitUntil(delivery.finally(() => { if (this.deliveries.get(thread) === delivery) this.deliveries.delete(thread); }));
      }
    }
  }

  private loadSettings(): Promise<SettingsSnapshot> {
    return this.settingsLoad ??= this.env.REGISTRY.getByName("main").settings().catch(error => {
      this.settingsLoad = undefined;
      throw error;
    });
  }

  async reloadSettings(): Promise<string> {
    this.settingsLoad = undefined;
    return (await this.loadSettings()).revision;
  }

  async threadList(): Promise<{ key: string; seenAt: number; name?: string }[]> {
    const rows = this.ctx.storage.sql.exec<{ key: string; seen_at: number }>("SELECT key, seen_at FROM threads ORDER BY seen_at DESC, key LIMIT 50").toArray();
    const names = await this.ctx.storage.get<GroupName>(rows.filter(row => row.key.startsWith("group:")).map(row => row.key));
    return rows.map(row => {
      const name = names.get(row.key)?.name;
      return { key: row.key, seenAt: row.seen_at, ...(name ? { name } : {}) };
    });
  }

  releaseSendRule(scope: string): { released: boolean } {
    return { released: this.rules.release(scope) };
  }

  private groupName(groupId: string): Promise<string | undefined> {
    const existing = this.groupQueries.get(groupId);
    if (existing) return existing;
    const query = (async () => {
      const cached = await this.ctx.storage.get<GroupName>(`group:${groupId}`);
      if (cached && cached.expires > Date.now()) return cached.name || undefined;
      let name = cached?.name;
      try {
        const result = await this.call("get_group_info", { group_id: groupId });
        if (isRecord(result) && typeof result.group_name === "string") name = cleanName(result.group_name);
      } catch {
        // 查名失败仍处理聊天；短暂负缓存避免每条群消息都再等待 15 秒。
        await this.ctx.storage.put(`group:${groupId}`, { name: name ?? "", expires: Date.now() + 60_000 } satisfies GroupName);
        return name;
      }
      await this.ctx.storage.put(`group:${groupId}`, { name: name ?? "", expires: Date.now() + 6 * 3600_000 } satisfies GroupName);
      return name;
    })();
    this.groupQueries.set(groupId, query);
    return query.finally(() => { this.groupQueries.delete(groupId); });
  }

  async send(target: Target, text: string, atUserId?: string): Promise<SendReceipt> {
    if (!this.activeSocket()) throw channelDown();
    const rejected = this.rules.accept(scopeOf(target), text);
    if (rejected) throw new Error(`send_rule: ${rejected}`);
    const segment = { type: "text", data: { text } };
    const message = target.kind === "group" && atUserId ? [{ type: "at", data: { qq: atUserId } }, segment] : [segment];
    const result = await this.call(target.kind === "private" ? "send_private_msg" : "send_group_msg",
      target.kind === "private" ? { user_id: target.userId, message } : { group_id: target.groupId, message });
    const messageId = isRecord(result) ? id(result.message_id) : "";
    if (!messageId) throw new Error("onebot_failed: 回执缺少消息 ID，请先核实，不要重试");
    return { message_id: messageId };
  }

  async sendPrivate(userId: string, text: string): Promise<SendReceipt> {
    return this.send({ kind: "private", userId }, text);
  }

  private async call(action: string, params: object): Promise<unknown> {
    const socket = this.activeSocket();
    if (!socket) throw channelDown();
    const echo = crypto.randomUUID();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise<unknown>((resolve, reject) => {
        this.pending.set(echo, { socket, resolve, reject });
        timer = setTimeout(() => reject(new Error("onebot_timeout: API 结果不确定，请先核实，不要重试")), 15_000);
        socket.send(JSON.stringify({ action, params, echo }));
      });
    } finally {
      // 计时器只在有在途 API 时存在，结算后清理，空闲 Bridge 才能休眠。
      if (timer !== undefined) clearTimeout(timer);
      this.pending.delete(echo);
    }
  }

  async status() {
    return { connected: this.activeSocket() !== undefined,
      selfId: await this.ctx.storage.get<string>("selfId"),
      ignored: await this.ctx.storage.get<number>("ignored") ?? 0,
      threads: this.ctx.storage.sql.exec<{ key: string }>("SELECT key FROM threads ORDER BY seen_at DESC, key LIMIT 50").toArray().map(row => row.key),
      sendRules: this.rules.breakers() };
  }

  threadKeys(): string[] {
    return this.ctx.storage.sql.exec<{ key: string }>("SELECT key FROM threads ORDER BY key").toArray().map(row => row.key);
  }

  private disconnect(socket: WebSocket): void {
    const attachment: Attachment | null = socket.deserializeAttachment();
    if (attachment) socket.serializeAttachment({ ...attachment, active: false });
    for (const pending of this.pending.values()) {
      if (pending.socket === socket) pending.reject(new Error("onebot_disconnected: API 结果不确定，请先核实，不要重试"));
    }
  }
  override webSocketClose(socket: WebSocket, code: number): void {
    this.disconnect(socket);
    socket.close(code === 1005 || code === 1006 ? 1000 : code);
  }
  override webSocketError(socket: WebSocket): void {
    this.disconnect(socket);
    socket.close(1011, "websocket error");
  }
}
