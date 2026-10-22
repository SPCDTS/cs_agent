import { isScheduleTool, SCHEDULE_TOOLS, type ScheduleTool, type ScheduleToolPermissions } from "../shared/schedule-tools.js";
import type { Channel, TurnBinding } from "../channel/types.js";
import { CHATS_DENIED, listChatsText } from "./chats.js";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { registerTemporarySecrets } from "../shared/redact.js";
import { accessToString, type Access } from "./access.js";
import { abortable, type MediaRecall, type RecallResult } from "./media.js";

/**
 * codex 的线程令牌（docs/ARCHITECTURE.md §4.1）：每个会话线程一个令牌，经 thread/start、thread/resume 的 config 写进该线程的 MCP 环境，
 * 只证明"来自哪个会话线程"。身份、读取范围与发送地址由网关在每次调用时按 MCP 请求的 `_meta`
 * （callId、x-codex-turn-metadata）从会话宿主的当前回合求出；调用不属于宿主当前回合（回合已结束、被取代、
 * 来自子 agent 线程）时网关拒绝——与第 2 阶段"回合租约须仍是宿主当前回合"同一保证。
 */

/** MCP tools/call 的 _meta 中与归属有关的字段（codex 随每次调用提供）。 */
export interface CallMeta {
  /** 与 mcpToolCall 条目 id 相同（exec-<uuid>）：发送的调用键 */
  callId?: string;
  /** x-codex-turn-metadata.thread_id */
  threadId?: string;
  /** x-codex-turn-metadata.turn_id（有则直接用于回合判定） */
  turnId?: string;
}

/** 网关求出的单次调用绑定。 */
export interface CallBinding extends TurnBinding {
  turnId: string;
  access: Access;
  /** 会话工作区（发送附件的根目录） */
  workdir: string;
  /** codex 线程 id（内置生图 generated_images/<id> 可发送） */
  session: string;
  /** 本会话的图片目录 ${DATA_DIR}/images/<会话>（Outbox 副本，send_message 可发送） */
  imageDir: string;
}

export interface ThreadGateway {
  /** 本次调用的绑定；调用不属于会话当前回合时抛错。 */
  resolve(threadKey: string, meta: CallMeta): Promise<CallBinding>;
  permissions?(binding: CallBinding): Promise<{ actorIsOwner: boolean; target: boolean; auth: boolean } & Partial<ScheduleToolPermissions>>;
  auth?(binding: CallBinding, name: "auth_grant" | "auth_revoke" | "auth_list", args: unknown): Promise<unknown>;
  schedule?(binding: CallBinding, name: ScheduleTool, args: unknown): Promise<string>;
  skillPublish?(binding: CallBinding, args: unknown): Promise<unknown>;
  /** callKey 为 MCP 请求的 _meta.callId */
  send(binding: CallBinding, callKey: string, args: unknown, signal: AbortSignal): Promise<unknown>;
}

interface Lease {
  threadKey: string;
  control: AbortController;
  dispose(): void;
}
export const SKILL_OWNER_ONLY = "发布技能仅限 owner 本人发起的回合";
export const RECALL_QUOTA_MESSAGE = "本轮召回次数已用完";

/** qq_context 每次调用取用的上下文（/context 端点）。 */
export interface CallContext {
  access: string;
  turn_id: string;
  session: string;
}

/** 令牌只在主进程保存；同一会话重新签发（app-server 重启、线程重新加载）即作废旧令牌并中止其在途请求。 */
export class ThreadTokens {
  private readonly tokens = new Map<string, Lease>();
  private readonly byThread = new Map<string, string>();
  /** 召回额度按回合计 */
  private readonly recalls = new Map<string, number>();
  constructor(private readonly media: Pick<MediaRecall, "recall"> & Partial<Pick<MediaRecall, "view">>, private readonly gateway: ThreadGateway,
    readonly maxPerTurn = 5, private readonly channel?: Pick<Channel, "listChats">) {}

  /** 为会话线程签发令牌，作废该会话的旧令牌。 */
  issue(threadKey: string): string {
    if (!threadKey) throw new Error("线程令牌缺少会话");
    this.revoke(threadKey);
    const token = randomBytes(32).toString("hex"), control = new AbortController();
    this.tokens.set(token, { threadKey, control, dispose: registerTemporarySecrets([token]) });
    this.byThread.set(threadKey, token);
    return token;
  }

  revoke(threadKey: string): void {
    const token = this.byThread.get(threadKey);
    if (token) this.drop(token);
  }

  private drop(token: string): void {
    const lease = this.tokens.get(token);
    if (!lease) return;
    this.tokens.delete(token);
    if (this.byThread.get(lease.threadKey) === token) this.byThread.delete(lease.threadKey);
    lease.dispose();
    lease.control.abort(new Error("线程令牌已作废"));
  }

  valid(token: string): boolean {
    const lease = this.tokens.get(token);
    return !!lease && !lease.control.signal.aborted;
  }

  /** 校验令牌并由网关求出本次调用的绑定；求绑定期间令牌被作废同样拒绝。 */
  private async bind(token: string, meta: CallMeta): Promise<{ binding: CallBinding; signal: AbortSignal }> {
    if (!this.valid(token)) throw new Error("线程令牌无效或已作废");
    const lease = this.tokens.get(token)!;
    const binding = await this.gateway.resolve(lease.threadKey, meta);
    if (!this.valid(token)) throw new Error("线程令牌已作废");
    return { binding, signal: lease.control.signal };
  }

  async send(token: string, meta: CallMeta, args: unknown): Promise<unknown> {
    if (!meta.callId) throw new Error("发送工具缺少稳定调用 id");
    const { binding, signal } = await this.bind(token, meta);
    return this.gateway.send(binding, meta.callId, args, signal);
  }

  async context(token: string, meta: CallMeta): Promise<CallContext> {
    const { binding } = await this.bind(token, meta);
    return { access: accessToString(binding.access), turn_id: binding.turnId, session: binding.session };
  }

  async auth(token: string, meta: CallMeta, name: "auth_grant" | "auth_revoke" | "auth_list", args: unknown) {
    const { binding } = await this.bind(token, meta);
    const permissions = await this.gateway.permissions?.(binding);
    if (!permissions?.auth || !this.gateway.auth) throw new Error("授权工具仅限 owner 回合");
    return this.gateway.auth(binding, name, args);
  }

  async skillPublish(token: string, meta: CallMeta, args: unknown): Promise<unknown> {
    const { binding } = await this.bind(token, meta);
    if (!(await this.gateway.permissions?.(binding))?.actorIsOwner || !this.gateway.skillPublish) throw new Error(SKILL_OWNER_ONLY);
    return this.gateway.skillPublish(binding, args);
  }

  async schedule(token: string, meta: CallMeta, name: ScheduleTool, args: unknown): Promise<string> {
    const { binding } = await this.bind(token, meta);
    const permissions = await this.gateway.permissions?.(binding);
    if (!(name === "schedule_control" ? permissions?.scheduleControl : permissions?.schedule) || !this.gateway.schedule) {
      throw new Error("本回合无权使用此定时工具");
    }
    return this.gateway.schedule(binding, name, args);
  }

  async recall(token: string, meta: CallMeta, messageId: string): Promise<RecallResult> {
    const { binding, signal } = await this.bind(token, meta);
    const used = this.recalls.get(binding.turnId) ?? 0;
    if (used >= this.maxPerTurn) throw new Error(RECALL_QUOTA_MESSAGE);
    this.recalls.delete(binding.turnId);
    this.recalls.set(binding.turnId, used + 1);
    if (this.recalls.size > 1000) this.recalls.delete(this.recalls.keys().next().value!);
    const result = await abortable(this.media.recall(binding.access, messageId, signal), signal);
    if (!this.valid(token)) throw new Error("线程令牌已作废");
    return result;
  }

  async view(token: string, meta: CallMeta, file: string) {
    const { binding, signal } = await this.bind(token, meta);
    if (!this.media.view) throw new Error("图片查看未启用");
    const result = await abortable(this.media.view(binding.access, file), signal);
    if (!this.valid(token)) throw new Error("线程令牌已作废");
    return result;
  }

  async chats(token: string, meta: CallMeta): Promise<{ text: string }> {
    const { binding, signal } = await this.bind(token, meta);
    const text = await listChatsText(binding.access, this.channel, signal);
    if (!this.valid(token)) throw new Error("线程令牌已作废");
    return { text };
  }

  close(): void {
    for (const token of [...this.tokens.keys()]) this.drop(token);
  }
}

/** 调用元数据经请求头传入（JSON，有界）；只取字符串字段。 */
export const CALL_META_HEADER = "x-cs-call-meta";

export function parseCallMeta(raw: string | string[] | undefined): CallMeta {
  if (raw === undefined) return {};
  if (typeof raw !== "string" || raw.length > 2048) throw new Error("调用元数据无效");
  const value = JSON.parse(raw) as Record<string, unknown>;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("调用元数据无效");
  const meta: CallMeta = {};
  for (const key of ["callId", "threadId", "turnId"] as const) {
    const field = value[key];
    if (field === undefined) continue;
    if (typeof field !== "string" || !/^[A-Za-z0-9_.:-]{1,200}$/.test(field)) throw new Error("调用元数据无效");
    meta[key] = field;
  }
  return meta;
}

/** 只监听 IPv4 loopback；不接受调用方提供的 scope/access，且限制请求体大小。 */
export async function startMediaRecallServer(tokens: ThreadTokens, port = 8790) {
  const server = createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }).end(JSON.stringify(body));
    };
    if (req.method !== "POST" || !["/recall", "/view", "/chats", "/send", "/context", "/auth_grant", "/auth_revoke", "/auth_list", "/skill_publish", ...SCHEDULE_TOOLS.map(name => "/" + name)].includes(req.url ?? "")) { send(404, { error: "不存在的召回端点" }); return; }
    const auth = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization ?? "");
    if (!auth || !tokens.valid(auth[1]!)) { send(401, { error: "线程令牌无效或已作废" }); return; }
    try {
      const meta = parseCallMeta(req.headers[CALL_META_HEADER]);
      let size = 0; const chunks: Buffer[] = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > (["/send", "/auth_grant", "/schedule_create", "/schedule_update"].includes(req.url!) ? 64 * 1024 : 2048)) { send(413, { error: "请求过大" }); return; }
        chunks.push(Buffer.from(chunk));
      }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const empty = !!body && typeof body === "object" && !Array.isArray(body) && !Object.keys(body).length;
      if (req.url === "/context") {
        if (!empty) throw new Error("context 不接受参数");
        send(200, await tokens.context(auth[1]!, meta)); return;
      }
      if (req.url === "/auth_grant" || req.url === "/auth_revoke" || req.url === "/auth_list") {
        send(200, await tokens.auth(auth[1]!, meta, req.url.slice(1) as "auth_grant" | "auth_revoke" | "auth_list", body)); return;
      }
      if (req.url === "/skill_publish") { send(200, await tokens.skillPublish(auth[1]!, meta, body)); return; }
      const scheduleTool = req.url!.slice(1);
      if (isScheduleTool(scheduleTool)) {
        send(200, await tokens.schedule(auth[1]!, meta, scheduleTool, body)); return;
      }
      if (req.url === "/send") { send(200, await tokens.send(auth[1]!, meta, body)); return; }
      if (req.url === "/chats") {
        if (!empty) { send(400, { error: "qq_chats 不接受参数" }); return; }
        send(200, await tokens.chats(auth[1]!, meta)); return;
      }
      if (req.url === "/view") {
        if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 ||
            !("path" in body) || typeof body.path !== "string" || !body.path || body.path.length > 1024) {
          send(400, { error: "仅接受 path" }); return;
        }
        send(200, await tokens.view(auth[1]!, meta, body.path)); return;
      }
      if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 ||
          !("message_id" in body) || typeof body.message_id !== "string" || !body.message_id.trim() || body.message_id.length > 128) {
        send(400, { error: "仅接受 message_id" }); return;
      }
      send(200, await tokens.recall(auth[1]!, meta, body.message_id));
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
