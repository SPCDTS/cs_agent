import { isScheduleTool, SCHEDULE_TOOLS, type ScheduleTool, type ScheduleToolPermissions } from "../shared/schedule-tools.js";
import type { Channel } from "../channel/types.js";
import { CHATS_DENIED, listChatsText } from "./chats.js";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { registerTemporarySecrets } from "../shared/redact.js";
import { accessToString, parseAccess, type Access } from "./access.js";
import { abortable, type MediaRecall, type RecallResult } from "./media.js";

/**
 * codex 每次 exec 的租约（第 2 阶段）：令牌只证明"来自哪个会话的哪一轮"；发送者身份、目标授权由网关在每次调用时
 * 从会话宿主求出（设计 §5.3、§7.3）。读取范围在 exec 开始时按本轮身份确定，回合内不变（codex 不插话）。
 */
export interface RecallBinding {
  threadKey: string; turnId: string;
  access: Access; deadline: number; signal?: AbortSignal;
  workdir?: string; session?: string;
}
export interface SendGateway {
  permissions?(binding: RecallBinding): Promise<{ actorIsOwner: boolean; target: boolean; auth: boolean } & Partial<ScheduleToolPermissions>>;
  auth?(binding: RecallBinding, name: "auth_grant" | "auth_revoke" | "auth_list", args: unknown): Promise<unknown>;
  schedule?(binding: RecallBinding, name: ScheduleTool, args: unknown): Promise<string>;
  /** callKey 为本回合内的稳定序号（`<turnId>#<n>`） */
  send(binding: RecallBinding, callKey: string, args: unknown, signal: AbortSignal): Promise<unknown>;
}
interface Lease {
  binding: RecallBinding;
  remaining: number;
  control: AbortController;
  timer: NodeJS.Timeout;
  revoke(): void;
}
export const RECALL_QUOTA_MESSAGE = "本轮召回次数已用完";

/** 令牌只在主进程保存；每次 exec 一个租约，召回额度按租约计，结束时立即撤销所有在途请求。 */
export class RecallTokens {
  private readonly tokens = new Map<string, Lease>();
  /** 按回合计的发送序号：同一回合的多次 exec（如失效线程回退）不复用调用键 */
  private readonly sends = new Map<string, number>();
  constructor(private readonly media: Pick<MediaRecall, "recall"> & Partial<Pick<MediaRecall, "view">>, readonly maxPerTicket = 5, private readonly channel?: Pick<Channel, "listChats">, private readonly gateway?: SendGateway) {}

  issue(binding: RecallBinding): { token: string; revoke(): void; session(value: string): void } {
    const access = accessToString(binding.access);
    if (!parseAccess(access) || !binding.threadKey || !binding.turnId || !Number.isFinite(binding.deadline) || binding.deadline <= Date.now()) throw new Error("召回绑定无效或已过期");
    binding.signal?.throwIfAborted();
    const token = randomBytes(32).toString("hex"), control = new AbortController();
    const disposeSecret = registerTemporarySecrets([token]);
    const revoke = () => {
      const lease = this.tokens.get(token);
      if (!lease) return;
      this.tokens.delete(token); clearTimeout(lease.timer);
      disposeSecret();
      binding.signal?.removeEventListener("abort", revoke);
      control.abort(new Error("召回令牌已作废"));
    };
    const timer = setTimeout(revoke, Math.max(1, binding.deadline - Date.now()));
    timer.unref();
    this.tokens.set(token, { binding: { ...binding, access: { ...binding.access } }, remaining: this.maxPerTicket, control, timer, revoke });
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
    if (!this.gateway || !lease.binding.workdir) throw new Error("发送令牌未绑定本回合会话");
    // 同一回合的调用依次编号；exec 不会重放，键在回合内唯一即可。
    const n = (this.sends.get(lease.binding.turnId) ?? 0) + 1;
    this.sends.delete(lease.binding.turnId);
    this.sends.set(lease.binding.turnId, n);
    if (this.sends.size > 1000) this.sends.delete(this.sends.keys().next().value!);
    return this.gateway.send(lease.binding, `${lease.binding.turnId}#${n}`, args, lease.control.signal);
  }

  async permissions(token: string) {
    if (!this.valid(token)) throw new Error("发送令牌无效或已过期");
    const result = await this.gateway?.permissions?.(this.tokens.get(token)!.binding) ?? { actorIsOwner: false, target: false, auth: false };
    if (!this.valid(token)) throw new Error("发送令牌已作废");
    return result;
  }

  async auth(token: string, name: "auth_grant" | "auth_revoke" | "auth_list", args: unknown) {
    if (!this.valid(token)) throw new Error("发送令牌无效或已过期");
    const binding = this.tokens.get(token)!.binding;
    if (!(await this.permissions(token)).auth || !this.gateway?.auth) throw new Error("授权工具仅限 owner 回合");
    return this.gateway.auth(binding, name, args);
  }

  async schedule(token: string, name: ScheduleTool, args: unknown): Promise<string> {
    if (!this.valid(token)) throw new Error("定时工具令牌无效或已过期");
    const binding = this.tokens.get(token)!.binding;
    const permissions = await this.permissions(token);
    if (!(name === "schedule_control" ? permissions.scheduleControl : permissions.schedule) || !this.gateway?.schedule) {
      throw new Error("本回合无权使用此定时工具");
    }
    return this.gateway.schedule(binding, name, args);
  }

  async recall(token: string, messageId: string): Promise<RecallResult> {
    if (!this.valid(token)) throw new Error("召回令牌无效或已过期");
    const lease = this.tokens.get(token)!;
    if (lease.remaining <= 0) throw new Error(RECALL_QUOTA_MESSAGE);
    lease.remaining--;
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
  }
}

/** 只监听 IPv4 loopback；不接受调用方提供的 scope/access，且限制请求体大小。 */
export async function startMediaRecallServer(tokens: RecallTokens, port = 8790) {
  const server = createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }).end(JSON.stringify(body));
    };
    if (req.method !== "POST" || !["/recall", "/view", "/chats", "/send", "/im-info", "/auth_grant", "/auth_revoke", "/auth_list", ...SCHEDULE_TOOLS.map(name => "/" + name)].includes(req.url ?? "")) { send(404, { error: "不存在的召回端点" }); return; }
    const auth = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization ?? "");
    if (!auth || !tokens.valid(auth[1]!)) { send(401, { error: "召回令牌无效或已过期" }); return; }
    try {
      let size = 0; const chunks: Buffer[] = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > (["/send", "/auth_grant", "/schedule_create", "/schedule_update"].includes(req.url!) ? 64 * 1024 : 2048)) { send(413, { error: "请求过大" }); return; }
        chunks.push(Buffer.from(chunk));
      }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (req.url === "/im-info") {
        if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length) throw new Error("im-info 不接受参数");
        send(200, await tokens.permissions(auth[1]!)); return;
      }
      if (req.url === "/auth_grant" || req.url === "/auth_revoke" || req.url === "/auth_list") {
        send(200, await tokens.auth(auth[1]!, req.url.slice(1) as "auth_grant" | "auth_revoke" | "auth_list", body)); return;
      }
      const scheduleTool = req.url!.slice(1);
      if (isScheduleTool(scheduleTool)) {
        send(200, await tokens.schedule(auth[1]!, scheduleTool, body)); return;
      }
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
