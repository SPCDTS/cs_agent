import { parseTarget, type GrantsService } from "./grants.js";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { ticketTarget } from "../channel/ticket.js";
import type { Channel, ReplyTicketRecord, TurnIdentity } from "../channel/types.js";
import { isModelOutboxRow, type OutboxRow } from "../channel/outbox.js";
import { prepareSendAttachments, readAttachmentData, type AttachmentLimits } from "../media/attach.js";
import { readMediaFile } from "../context/media.js";
import type { Access } from "../context/access.js";
import type { ContextStore } from "../context/store.js";
import { trace } from "../shared/trace.js";
import { log } from "../shared/log.js";

export const SEND_RULE = "回复用户必须调用 send_message；直接输出的文字不会发给用户。一条消息说完就不要再发，不发送重复说明。用户消息回合最多 3 条、定时任务回合最多 5 条消息，每条文字 1～4000 字符，可附 4 张图片、3 个文件（单个不超过 20 MiB）。";
export interface SendResult {
  status: OutboxRow["status"]; already_sent: boolean; message_id: string | null;
  message_type: OutboxRow["message_type"]; target_id: string; note?: string; original_text?: string;
}
export interface SendArguments { target?: string; text: string; images?: string[]; files?: { path: string; name?: string }[] }
export interface SendBinding extends Partial<TurnIdentity> {
  ticket: string; access: Access; workdir: string; extraRoots?: string[];
  source?: { type: "private" | "group"; user_id: string; group_id: string | null };
}
export type SendChannel = Pick<Channel, "outbox" | "send" | "uploadFile" | "getTicket" | "settleTicket"> & Partial<Pick<Channel, "listChats">>;

/** 参数校验在网关执行；MCP 与 pi 均把错误作为工具文本返回。 */
export function validateSendArguments(input: unknown): SendArguments {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("send_message 参数必须是对象");
  const a = input as Record<string, unknown>;
  if (Object.keys(a).some(k => !["text", "images", "files", "target"].includes(k))) throw new Error("仅接受 text、images、files、target");
  if (a.target !== undefined) parseTarget(a.target);
  if (typeof a.text !== "string" || !a.text.trim() || a.text.length > 4000) throw new Error("消息必须是 1～4000 字符的非空文字");
  const validPath = (v: unknown) => typeof v === "string" && !!v.trim() && v.length <= 1024;
  if (a.images !== undefined && (!Array.isArray(a.images) || a.images.length > 4 || !a.images.every(validPath))) throw new Error("images 最多 4 个本地图片路径");
  if (a.files !== undefined && (!Array.isArray(a.files) || a.files.length > 3 || a.files.some(f =>
    !f || typeof f !== "object" || Array.isArray(f) || !validPath(f.path) ||
    (f.name !== undefined && !validPath(f.name)) || Object.keys(f).some(k => k !== "path" && k !== "name")))) throw new Error("files 最多 3 个 { path, name? } 文件");
  return a as unknown as SendArguments;
}

/** 按票据串行分配序号及发送；计数器只活在本次 codex exec，持久幂等由 Outbox 保证。 */
export class SendService {
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly counters = new Map<string, number>();
  private chats?: { value: Awaited<ReturnType<Channel["listChats"]>>; expires: number };
  constructor(private readonly opts: { grants?: GrantsService; now?: () => number; getChannel(): SendChannel; dataDir: string; store?: Pick<ContextStore, "mediaPathAllowed" | "recordSent">; limits?: AttachmentLimits }) {}
  rows(ticket: string) { return this.opts.getChannel().outbox.listOutbox(ticket); }
  releaseAttempt(ticket: string, attempt: string) { this.counters.delete(ticket + ":" + attempt); }

  private async serial<T>(ticket: string, fn: () => Promise<T>): Promise<T> {
    const task = (this.queues.get(ticket) ?? Promise.resolve()).catch(() => {}).then(fn);
    this.queues.set(ticket, task);
    try { return await task; } finally { if (this.queues.get(ticket) === task) this.queues.delete(ticket); }
  }

  async send(binding: SendBinding, input: unknown, identity: { callId: string } | { attempt: string }, signal?: AbortSignal) {
    return this.serial(binding.ticket, async () => {
      signal?.throwIfAborted();
      if ("callId" in identity && !identity.callId) throw new Error("发送工具缺少稳定调用 id");
      const args = validateSendArguments(input), channel = this.opts.getChannel();
      const rec = await this.record(binding.ticket, binding.source);
      const sourceRef = `qq:${rec.message_type}:${ticketTarget(rec)}`;
      const targetRef = args.target ?? sourceRef, target = parseTarget(targetRef), targeted = targetRef !== sourceRef;
      const proactive = targeted || rec.origin === "scheduled";
      const rows = this.rows(binding.ticket);
      const attempt = "attempt" in identity ? binding.ticket + ":" + identity.attempt : undefined;
      const ordinal = attempt ? (this.counters.get(attempt) ?? 0) + 1 : undefined;
      // 校验失败不计调用；有效调用（含发送失败）按次序重放。
      const existing = "callId" in identity ? rows.find(r => r.call_id === identity.callId) : rows.find(r => r.key === binding.ticket + "#" + ordinal);
      const hash = createHash("sha256").update(args.text).digest("hex");
      if (existing && attempt && (existing.text_sha256 !== hash || existing.message_type !== target.message_type || existing.target_id !== target.target_id)) {
        this.counters.set(attempt, ordinal!);
        return { ...this.result(existing, true), original_text: existing.text,
          note: (this.result(existing, true).note ?? "") + "本次调用映射到已有消息。新内容未发送，如需发送请再调用一次。" };
      }
      // 文本去重在附件读取、限额与新建行之前；不确定的消息不能通过新 call_id 重发。
      const duplicate = !existing && rows.find(r => r.status !== "pending" && r.text_sha256 === hash && r.message_type === target.message_type && r.target_id === target.target_id);
      if (duplicate) {
        if (attempt) this.counters.set(attempt, ordinal!);
        return this.deliver(duplicate, rec, signal);
      }
      const limit = rec.origin === "scheduled" ? 5 : 3;
      if (!existing && rows.filter(isModelOutboxRow).length >= limit) throw new Error(`本回合最多发送 ${limit} 条消息`);
      // 已发回执可重放；仍待发送的行使用原目标，不能通过更换参数绕过授权。
      if (existing && (existing.message_type !== target.message_type || existing.target_id !== target.target_id)) {
        return { ...this.result(existing, true), original_text: existing.text, note: "调用 id 已绑定其他消息，新内容未发送。" };
      }
      if (existing && existing.status !== "pending") {
        if (attempt) this.counters.set(attempt, ordinal!);
        return this.deliver(existing, rec, signal);
      }
      if (targeted) {
        if (!this.opts.grants) throw new Error("主动发送授权未启用");
        await this.opts.grants.authorizeSend(binding, targetRef);
        await this.checkMembership(target, signal);
      }
      // 定时消息也是主动发送；默认来源与显式 target 共用每天每 ref 的额度。
      if (proactive) {
        const day = this.day();
        if (!existing && channel.outbox.countModelOutbox(target.message_type, target.target_id, day.start, day.end) >= 100) {
          throw new Error("该 target 当天最多主动发送 100 条消息（Asia/Shanghai）");
        }
      }
      let row = existing;
      if (!row) {
        if (rec.status !== "pending") throw new Error("本回合已经结束");
        const prepared = await prepareSendAttachments({
          workdir: binding.workdir, extraRoots: binding.extraRoots,
          mediaCheck: async file => {
            if (!this.opts.store?.mediaPathAllowed(binding.access, file)) return false;
            await readMediaFile(this.opts.dataDir, file); return true;
          },
        }, args, this.opts.limits);
        signal?.throwIfAborted();
        const dir = path.join(this.opts.dataDir, "images", binding.ticket, "outbox", randomUUID());
        await fs.mkdir(dir, { recursive: true });
        const images: string[] = [], files: OutboxRow["files"] = [];
        for (const [i, image] of prepared.images.entries()) {
          const file = path.join(dir, `image-${i}.png`);
          await fs.writeFile(file, image.data, { flag: "wx" }); images.push(file);
        }
        for (const [i, file] of prepared.files.entries()) {
          const filename = path.join(dir, `file-${i}`);
          await fs.writeFile(filename, file.data, { flag: "wx" });
          files.push({ filename, name: file.name, bytes: file.data.length, sha256: file.sha256, status: "pending" });
        }
        if (targeted) await this.opts.grants!.authorizeSend(binding, targetRef);
        signal?.throwIfAborted();
        row = channel.outbox.reserveOutbox({
          ticket: binding.ticket, sequence: ordinal, call_id: "callId" in identity ? identity.callId : null,
          message_type: target.message_type, target_id: target.target_id,
          mention_user_id: !targeted && rec.origin !== "scheduled" && rec.message_type === "group" && !rows.some(r => r.status !== "pending") ? rec.user_id : null,
          ...(proactive ? { dailyLimit: { ...this.day(), limit: 100 } } : {}),
          proactive, text: args.text, images, files,
        });
      }
      if (attempt) this.counters.set(attempt, ordinal!);
      return this.deliver(row, rec, signal);
    });
  }

  private day() {
    const now = (this.opts.now ?? Date.now)();
    const start = Math.floor((now + 8 * 3_600_000) / 86_400_000) * 86_400_000 - 8 * 3_600_000;
    return { start: new Date(start).toISOString(), end: new Date(start + 86_400_000).toISOString() };
  }

  private async checkMembership(target: ReturnType<typeof parseTarget>, signal?: AbortSignal) {
    const now = (this.opts.now ?? Date.now)();
    if (!this.chats || this.chats.expires <= now) {
      const channel = this.opts.getChannel();
      if (!channel.listChats) throw new Error("无法检查目标群或好友");
      const value = await channel.listChats({ signal: signal ?? AbortSignal.timeout(30_000) });
      this.chats = { value, expires: (this.opts.now ?? Date.now)() + 5 * 60_000 };
    }
    const found = target.message_type === "group" ? this.chats.value.groups.some(g => g.group_id === target.target_id)
      : this.chats.value.friends.some(f => f.user_id === target.target_id);
    if (!found) throw new Error("bot 不在目标群或对方不是好友");
  }

  /** #late、#fallback 由任务调用；不暴露给模型。 */
  async system(ticket: string, suffix: "late" | "fallback", text: string, images: string[] = [], signal?: AbortSignal, noSendFallback = false,
    onReserved?: () => Promise<void>) {
    return this.serial(ticket, async () => {
      const rec = await this.record(ticket), rows = this.rows(ticket);
      if (rec.origin === "scheduled") throw new Error("定时回合不发送系统补发消息");
      if (rec.status !== "pending") throw new Error("本回合已经结束");
      const existing = rows.find(row => row.key === ticket + "#" + suffix);
      const row = this.opts.getChannel().outbox.reserveOutbox({
        ticket, suffix, call_id: null, text, images, files: [],
        message_type: rec.message_type, target_id: ticketTarget(rec),
        mention_user_id: rec.message_type === "group" && !rows.some(r => r.status !== "pending") ? rec.user_id : null,
      });
      if (!existing && suffix === "fallback" && noSendFallback) trace.event(ticket, "no_send_fallback");
      await onReserved?.();
      return this.deliver(row, rec, signal);
    });
  }

  /** settle / 派发恢复补齐 sent 行的附件及历史；不重发 uncertain 行。 */
  async reconcile(ticket: string, signal?: AbortSignal): Promise<void> {
    await this.serial(ticket, async () => {
      const rec = await this.record(ticket);
      for (const row of this.rows(ticket)) if (row.status === "sent") await this.deliver(row, rec, signal);
    });
  }
  async settle(ticket: string) { await this.serial(ticket, () => this.opts.getChannel().settleTicket(ticket)); }

  /** 终结后清理 Outbox 副本；未完成上传所需的整个消息目录仍保留。 */
  async cleanup(ticket: string): Promise<void> {
    await this.serial(ticket, async () => {
      const rec = await this.record(ticket);
      if (rec.status === "pending") return;
      const root = path.resolve(this.opts.dataDir, "images", ticket, "outbox");
      const stat = await fs.lstat(root).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
      if (!stat) return;
      if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(root) !== root) throw new Error("Outbox 清理目录无效");
      const retained = this.rows(ticket).filter(row => row.files.some(file => file.status === "pending" || file.status === "sending"))
        .flatMap(row => [...row.images, ...row.files.map(file => file.filename)]).map(file => path.resolve(file));
      for (const entry of await fs.readdir(root)) {
        const target = path.resolve(root, entry);
        if (path.dirname(target) !== root) throw new Error("Outbox 清理路径越界");
        if (retained.some(file => file === target || file.startsWith(target + path.sep))) continue;
        const child = await fs.lstat(target);
        if (child.isSymbolicLink()) await fs.unlink(target);
        else await fs.rm(target, { recursive: true, force: true });
      }
      if (!(await fs.readdir(root)).length) await fs.rmdir(root);
    });
  }

  private result(row: OutboxRow, alreadySent: boolean): SendResult {
    return { status: row.status, already_sent: alreadySent, message_id: row.message_id || null,
      message_type: row.message_type, target_id: row.target_id,
      ...(row.status === "sending" || row.status === "uncertain" ? { note: "消息可能已送达，不要重发。" }
        : row.status === "sent" && !row.message_id ? { note: "消息已记录为发送成功，但缺少 message_id 回执；不要重发。" } : {}) };
  }

  private async record(ticket: string, source?: SendBinding["source"]) {
    const rec = await this.opts.getChannel().getTicket(ticket);
    if (!rec || !/^[a-zA-Z0-9_-]+$/.test(ticket)) throw new Error("回合票据不存在或无效");
    if (source && (source.type !== rec.message_type || source.user_id !== rec.user_id || source.group_id !== rec.group_id)) throw new Error("回合来源不一致");
    return rec;
  }
  private async deliver(row: OutboxRow, rec: ReplyTicketRecord, signal?: AbortSignal) {
    const channel = this.opts.getChannel();
    const before = row.status;
    let alreadySent: boolean;
    try {
      alreadySent = (await channel.send(row.key, row, row.text, row.images, { mention: row.mention_user_id ?? undefined, signal })).already_sent;
    } catch (error) {
      row = channel.outbox.getOutbox(row.key)!;
      if (row.status !== "sending" && row.status !== "uncertain") throw error;
      alreadySent = before !== "pending";
    }
    row = channel.outbox.getOutbox(row.key)!;
    const result = this.result(row, alreadySent);
    try {
      if (row.status !== "sent") return result;
      // 每条消息立即入库；恢复再写是幂等的，引用无需等整个回合结束。
      try { if (row.message_id) this.opts.store?.recordSent(row, rec); }
      catch (error) { log.warn("outbox context record failed; reconciliation will retry", { key: row.key, error }); }
      for (const [index, file] of channel.outbox.getOutbox(row.key)!.files.entries()) {
        if (file.status === "sent" || file.status === "uncertain") continue;
        if (file.status === "sending") { channel.outbox.updateOutboxFile(row.key, index, "uncertain"); continue; }
        signal?.throwIfAborted();
        channel.outbox.updateOutboxFile(row.key, index, "sending");
        let fileId: string | undefined;
        try {
          const data = await readAttachmentData(path.dirname(file.filename), { ...file, filename: path.basename(file.filename), originalPath: "", source: "workspace" });
          fileId = (await channel.uploadFile(row.message_type, row.target_id, data, file.name)).file_id;
          if (!fileId) throw new Error("文件上传缺少 file_id");
        } catch (error) { log.warn("outbox file uncertain; will not retry", { key: row.key, name: file.name, error }); }
        channel.outbox.updateOutboxFile(row.key, index, fileId ? "sent" : "uncertain", fileId);
      }
      return result;
    } finally {
      if (!result.already_sent) trace.event(row.ticket, "send_message", { detail: { target: `qq:${row.message_type}:${row.target_id}`, ordinal: row.ordinal, message_id: result.message_id,
        status: result.status, images: row.images.length, files: channel.outbox.getOutbox(row.key)!.files.map(({ name, bytes, status }) => ({ name, bytes, status })),
        already_sent: false } });
    }
  }
}
