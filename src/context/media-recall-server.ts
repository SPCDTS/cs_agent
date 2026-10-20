import type { Channel } from "../channel/types.js";
import { CHATS_DENIED, listChatsText } from "./chats.js";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { registerTemporarySecrets } from "../shared/redact.js";
import { accessToString, parseAccess, type Access } from "./access.js";
import { abortable, type MediaRecall, type RecallResult } from "./media.js";

export interface RecallBinding {
  access: Access; ticket: string; deadline: number; signal?: AbortSignal;
  source?: { type: "private" | "group"; user_id: string; group_id: string | null };
  workdir?: string; session?: string;
}
export interface SendGateway {
  send(binding: RecallBinding, attempt: string, args: unknown, signal: AbortSignal): Promise<unknown>;
  release(ticket: string, attempt: string): void;
}
interface Lease {
  binding: RecallBinding;
  remaining: number;
  control: AbortController;
  timer: NodeJS.Timeout;
  revoke(): void;
}
export const RECALL_QUOTA_MESSAGE = "本轮召回次数已用完";
const QUOTA_RETENTION_MS = 30 * 60_000;
interface TicketQuota { access: string; used: number; active: number; lastRevoke: number; timer?: NodeJS.Timeout }

/** 令牌只在主进程保存；同票据重新 exec 不重置预算，结束时立即撤销所有在途请求。 */
export class RecallTokens {
  private readonly tokens = new Map<string, Lease>();
  private readonly tickets = new Map<string, TicketQuota>();
  constructor(private readonly media: Pick<MediaRecall, "recall"> & Partial<Pick<MediaRecall, "view">>, readonly maxPerTicket = 5, private readonly channel?: Pick<Channel, "listChats">, private readonly gateway?: SendGateway) {}

  issue(binding: RecallBinding): { token: string; revoke(): void; session(value: string): void } {
    const access = accessToString(binding.access);
    if (!parseAccess(access) || !binding.ticket || !Number.isFinite(binding.deadline) || binding.deadline <= Date.now()) throw new Error("召回绑定无效或已过期");
    binding.signal?.throwIfAborted();
    let quota = this.tickets.get(binding.ticket);
    // 定时器可能因事件循环忙碌延迟；新租约同样按实际时间检查重试窗口。
    if (quota && !quota.active && Date.now() - quota.lastRevoke >= QUOTA_RETENTION_MS) {
      clearTimeout(quota.timer); this.tickets.delete(binding.ticket); quota = undefined;
    }
    quota ??= { access, used: 0, active: 0, lastRevoke: 0 };
    if (quota.access !== access) throw new Error("召回票据范围不一致");
    clearTimeout(quota.timer); quota.timer = undefined; quota.active++;
    this.tickets.set(binding.ticket, quota);
    const token = randomBytes(32).toString("hex"), control = new AbortController();
    const disposeSecret = registerTemporarySecrets([token]);
    const revoke = () => {
      const lease = this.tokens.get(token);
      if (!lease) return;
      this.tokens.delete(token); clearTimeout(lease.timer);
      disposeSecret();
      this.gateway?.release(binding.ticket, token);
      quota.active--; quota.lastRevoke = Date.now();
      if (!quota.active) {
        quota.timer = setTimeout(() => {
          if (!quota.active && this.tickets.get(binding.ticket) === quota) this.tickets.delete(binding.ticket);
        }, QUOTA_RETENTION_MS);
        quota.timer.unref();
      }
      binding.signal?.removeEventListener("abort", revoke);
      control.abort(new Error("召回令牌已作废"));
    };
    const timer = setTimeout(revoke, Math.max(1, binding.deadline - Date.now()));
    timer.unref();
    this.tokens.set(token, { binding: { ...binding, access: { ...binding.access }, ...(binding.source ? { source: { ...binding.source } } : {}) }, remaining: Math.max(0, this.maxPerTicket - quota.used), control, timer, revoke });
    binding.signal?.addEventListener("abort", revoke, { once: true });
    return { token, revoke, session: value => {
      const lease = this.tokens.get(token);
      if (lease) lease.binding.session = value;
    } };
  }

  valid(token: string): boolean {
    const lease = this.tokens.get(token);
    return !!lease && lease.binding.deadline > Date.now() && !lease.control.signal.aborted;
  }

  async send(token: string, args: unknown): Promise<unknown> {
    if (!this.valid(token)) throw new Error("发送令牌无效或已过期");
    const lease = this.tokens.get(token)!;
    if (!this.gateway || !lease.binding.source || !lease.binding.workdir) throw new Error("发送令牌未绑定本回合来源");
    return this.gateway.send(lease.binding, token, args, lease.control.signal);
  }

  async recall(token: string, messageId: string): Promise<RecallResult> {
    if (!this.valid(token)) throw new Error("召回令牌无效或已过期");
    const lease = this.tokens.get(token)!;
    const quota = this.tickets.get(lease.binding.ticket)!;
    if (lease.remaining <= 0 || quota.used >= this.maxPerTicket) throw new Error(RECALL_QUOTA_MESSAGE);
    lease.remaining--; quota.used++;
    const result = await abortable(this.media.recall(lease.binding.access, messageId, lease.control.signal), lease.control.signal);
    if (!this.valid(token)) throw new Error("召回令牌已作废");
    return result;
  }

  async view(token: string, file: string) {
    if (!this.valid(token)) throw new Error("召回令牌无效或已过期");
    const lease = this.tokens.get(token)!;
    if (!this.media.view) throw new Error("图片查看未启用");
    const result = await abortable(this.media.view(lease.binding.access, file), lease.control.signal);
    if (!this.valid(token)) throw new Error("召回令牌已作废");
    return result;
  }

  async chats(token: string): Promise<{ text: string }> {
    if (!this.valid(token)) throw new Error("召回令牌无效或已过期");
    const lease = this.tokens.get(token)!;
    const text = await listChatsText(lease.binding.access, this.channel, lease.control.signal);
    if (!this.valid(token)) throw new Error("召回令牌已作废");
    return { text };
  }

  close(): void {
    for (const lease of this.tokens.values()) lease.revoke();
    for (const quota of this.tickets.values()) clearTimeout(quota.timer);
    this.tickets.clear();
  }
}

/** 只监听 IPv4 loopback；不接受调用方提供的 scope/access，且限制请求体大小。 */
export async function startMediaRecallServer(tokens: RecallTokens, port = 8790) {
  const server = createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }).end(JSON.stringify(body));
    };
    if (req.method !== "POST" || (req.url !== "/recall" && req.url !== "/view" && req.url !== "/chats" && req.url !== "/send")) { send(404, { error: "不存在的召回端点" }); return; }
    const auth = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization ?? "");
    if (!auth || !tokens.valid(auth[1]!)) { send(401, { error: "召回令牌无效或已过期" }); return; }
    try {
      let size = 0; const chunks: Buffer[] = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > (req.url === "/send" ? 64 * 1024 : 2048)) { send(413, { error: "请求过大" }); return; }
        chunks.push(Buffer.from(chunk));
      }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (req.url === "/send") { send(200, await tokens.send(auth[1]!, body)); return; }
      if (req.url === "/chats") {
        if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length) {
          send(400, { error: "qq_chats 不接受参数" }); return;
        }
        send(200, await tokens.chats(auth[1]!)); return;
      }
      if (req.url === "/view") {
        if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 ||
            !("path" in body) || typeof body.path !== "string" || !body.path || body.path.length > 1024) {
          send(400, { error: "仅接受 path" }); return;
        }
        send(200, await tokens.view(auth[1]!, body.path)); return;
      }
      if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 ||
          !("message_id" in body) || typeof body.message_id !== "string" || !body.message_id.trim() || body.message_id.length > 128) {
        send(400, { error: "仅接受 message_id" }); return;
      }
      const result = await tokens.recall(auth[1]!, body.message_id);
      send(200, result);
    } catch (err) {
      const message = (err as Error).message;
      send(message === RECALL_QUOTA_MESSAGE ? 429 : !tokens.valid(auth[1]!) ? 401 : message === CHATS_DENIED ? 403 : 400, { error: message });
    }
  });
  server.requestTimeout = 65_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return {
    port: (server.address() as AddressInfo).port,
    host: (server.address() as AddressInfo).address,
    close: async () => {
      tokens.close();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
