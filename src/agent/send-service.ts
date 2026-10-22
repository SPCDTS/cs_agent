import { parseTarget, type GrantsService } from "./grants.js";
import { runRights } from "./host/identity.js";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Channel, TurnBinding } from "../channel/types.js";
import type { OutboxRow } from "../channel/outbox.js";
import { isSendRuleError } from "../channel/send-rules.js";
import { prepareSendAttachments, readAttachmentData, type AttachmentLimits } from "../media/attach.js";
import { attachmentDirs } from "../media/attach-paths.js";
import { readMediaFile } from "../context/media.js";
import type { Access } from "../context/access.js";
import type { ContextStore } from "../context/store.js";
import { trace } from "../shared/trace.js";
import { log } from "../shared/log.js";

/** QQ 不渲染 Markdown：两后端共用的不带链接规则，优先于工具与技能里的引用要求。 */
export const QQ_LINK_RULE = "绝不在发给用户的消息里写链接、网址、引用标记或来源脚注，包括 [文字](网址)、([站名](网址))、[详情](网址)、\"来源：网址\" 等任何形式；检索结果只用自己的话写结论。联网工具的引用格式要求和技能（skills）里\"附来源链接\"的要求在 QQ 场景一律不适用，以本条为准。只有用户明确要求来源时才给，且只给 1 条纯网址。";
export const SEND_RULE = "用户只能看到 send_message 发出的内容；直接输出的文字用户完全看不到。要对用户说的话（答复、确认、结果、提问）都必须调用 send_message 发出，包括用其他工具办完事之后告诉用户结果的那一句；回合中途、子 agent 完成后都可以发。一条消息说完就不要再发，不发送重复说明。每条文字 1～4000 字符，可附 4 张图片、3 个文件（单个不超过 20 MiB）。";
export interface SendResult {
  status: OutboxRow["status"]; already_sent: boolean; message_id: string | null;
  message_type: OutboxRow["message_type"]; target_id: string; note?: string; original_text?: string;
}
export interface SendArguments { target?: string; text: string; images?: string[]; files?: { path: string; name?: string }[] }
/** 发送绑定 = 会话绑定（§7）+ 本次调用可读的附件根；身份由主进程在调用时求出。 */
export interface SendBinding extends TurnBinding {
  access: Access; workdir: string; extraRoots?: string[];
}
export type SendChannel = Pick<Channel, "outbox" | "inbox" | "send" | "uploadFile"> & Partial<Pick<Channel, "listChats" | "status">>;

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

/** 回合内的稳定调用键：pi 为 toolCallId，codex 为回合 id 与本回合序号。只允许安全字符，避免伪造系统行键。 */
function validCallKey(callKey: string): string {
  if (!/^[A-Za-z0-9_.:#|-]{1,200}$/.test(callKey) || callKey.startsWith("sys:")) throw new Error("发送工具缺少稳定调用 id");
  return callKey;
}

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

/**
 * 去重用的附件比较：图片按内容、文件按内容与显示名，保持顺序。
 * 已登记行的图片读 Outbox 副本；副本已被清理时内容未知，只要求数量一致（宁可不重发）。
 */
async function sameAttachments(row: OutboxRow, prepared: Awaited<ReturnType<typeof prepareSendAttachments>>): Promise<boolean> {
  if (row.images.length !== prepared.images.length || row.files.length !== prepared.files.length) return false;
  if (row.files.some((file, i) => file.sha256 !== prepared.files[i]!.sha256 || file.name !== prepared.files[i]!.name)) return false;
  const images = await Promise.all(row.images.map(file => fs.readFile(file).then(sha256, () => undefined)));
  return images.every((hash, i) => hash === undefined || hash === sha256(prepared.images[i]!.data));
}

/**
 * send_message 绑定会话（设计 §7）：行键 `<threadKey>:<callKey>`，同一调用重放取回同一行（永不重发）。
 * 没有"本回合已经结束"与每轮条数的校验；失控防护由 bridge 发送规则负责（§9）。按会话串行。
 */
export class SendService {
  private readonly queues = new Map<string, Promise<unknown>>();
  private chats?: { value: Awaited<ReturnType<Channel["listChats"]>>; expires: number };
  constructor(private readonly opts: {
    grants?: GrantsService; now?: () => number; getChannel(): SendChannel; dataDir: string;
    store?: Pick<ContextStore, "mediaPathAllowed" | "recordSent">; limits?: AttachmentLimits;
    /** 群会话本轮第一条发往本群的消息 @ 发送者（§7.2，ThreadHost.takeMention） */
    mention?(threadKey: string): Promise<string | false>;
  }) {}

  private async serial<T>(threadKey: string, fn: () => Promise<T>): Promise<T> {
    const task = (this.queues.get(threadKey) ?? Promise.resolve()).catch(() => {}).then(fn);
    this.queues.set(threadKey, task);
    try { return await task; } finally { if (this.queues.get(threadKey) === task) this.queues.delete(threadKey); }
  }

  async send(binding: SendBinding, input: unknown, callKey: string, signal?: AbortSignal): Promise<SendResult> {
    return this.serial(binding.threadKey, async () => {
      signal?.throwIfAborted();
      const key = `${binding.threadKey}:${validCallKey(callKey)}`;
      const args = validateSendArguments(input), channel = this.opts.getChannel();
      const sourceRef = `qq:${binding.scope}`;
      const targetRef = args.target ?? sourceRef, target = parseTarget(targetRef), targeted = targetRef !== sourceRef;
      // 权限一律按 runRights（§7.3）：只有会话基础权限的回合发往别处由 authorizeSend 拒绝；定时身份的发送计主动额度。
      const rights = this.opts.grants?.rights(binding) ?? runRights(binding, undefined);
      const proactive = targeted || rights.person?.kind === "scheduled";
      const existing = channel.outbox.getOutbox(key);
      // 已绑定的调用键原样重放；仍待发送的行使用原目标，不能通过更换参数绕过授权。
      if (existing && (existing.message_type !== target.message_type || existing.target_id !== target.target_id)) {
        return { ...this.result(existing, true), original_text: existing.text, note: "调用 id 已绑定其他消息，新内容未发送。" };
      }
      if (existing) {
        // 仍待发送的跨会话行每次重试都按当前身份重新授权（撤销即时生效）；已发出的行只取回执。
        const existingRef = `qq:${existing.message_type}:${existing.target_id}`;
        if (existing.status === "pending" && existingRef !== sourceRef) {
          if (!this.opts.grants) throw new Error("主动发送授权未启用");
          await this.opts.grants.authorizeSend(binding, existingRef);
        }
        return this.deliver(existing, signal);
      }
      // 同一回合里内容（正文 + 图片与文件内容）与目标相同、已发出或结果不确定的消息不能通过新的调用键重发。
      const hash = createHash("sha256").update(args.text).digest("hex");
      const candidates = binding.turnId ? channel.outbox.listOutboxByTurn(binding.turnId).filter(r => !r.system && r.status !== "pending" &&
        r.text_sha256 === hash && r.message_type === target.message_type && r.target_id === target.target_id) : [];
      let prepared: Awaited<ReturnType<typeof prepareSendAttachments>> | undefined;
      if (candidates.length) {
        prepared = await this.prepare(binding, args);
        for (const row of candidates) {
          if (await sameAttachments(row, prepared)) return this.deliver(row, signal);
        }
      }
      if (targeted) {
        if (!this.opts.grants) throw new Error("主动发送授权未启用");
        await this.opts.grants.authorizeSend(binding, targetRef);
        await this.checkMembership(target, signal);
      }
      // 定时消息也是主动发送；默认来源与显式 target 共用每天每 ref 的额度。
      if (proactive && channel.outbox.countModelOutbox(target.message_type, target.target_id, this.day().start, this.day().end) >= 100) {
        throw new Error("该 target 当天最多主动发送 100 条消息（Asia/Shanghai）");
      }
      prepared ??= await this.prepare(binding, args);
      signal?.throwIfAborted();
      const { images, files } = await this.copy(binding.threadKey, prepared);
      if (targeted) await this.opts.grants!.authorizeSend(binding, targetRef);
      signal?.throwIfAborted();
      const ownGroup = !targeted && target.message_type === "group" && binding.identity.kind === "user";
      const mention = ownGroup && this.opts.mention ? await this.opts.mention(binding.threadKey) : false;
      const row = channel.outbox.reserveOutbox({
        key, thread_key: binding.threadKey, turn_id: binding.turnId ?? null, input_key: binding.inputKey ?? null,
        message_type: target.message_type, target_id: target.target_id, mention_user_id: mention || null,
        ...(proactive ? { dailyLimit: { ...this.day(), limit: 100 } } : {}),
        proactive, text: args.text, images, files,
      });
      return this.deliver(row, signal);
    });
  }

  private prepare(binding: SendBinding, args: SendArguments) {
    return prepareSendAttachments({
      workdir: binding.workdir, extraRoots: binding.extraRoots,
      mediaCheck: async file => {
        if (!this.opts.store?.mediaPathAllowed(binding.access, file)) return false;
        await readMediaFile(this.opts.dataDir, file); return true;
      },
    }, args, this.opts.limits);
  }

  /** 附件先复制到会话的 Outbox 目录，发送与补传只读副本。 */
  private async copy(threadKey: string, prepared: Awaited<ReturnType<typeof prepareSendAttachments>>) {
    const dir = path.join(attachmentDirs(this.opts.dataDir, threadKey).attachDir, "outbox", randomUUID());
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
    return { images, files };
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

  /**
   * 系统消息（§8.1 出错提示；codex 回合后补收的图片）：键 `<threadKey>:sys:<uuid>`，发往本会话，不 @、不计主动额度、不暴露给模型。
   * 被发送规则拒绝时不重试也不抛出：行保持 pending 并记下原因。
   */
  /** key：调用方给出的稳定键（同一事件重试取回同一行，不重发）；缺省随机。 */
  async system(binding: Pick<TurnBinding, "threadKey" | "scope" | "inputKey" | "turnId">, text: string, images: string[] = [],
    options: { signal?: AbortSignal; key?: string } = {}): Promise<SendResult> {
    const signal = options.signal;
    return this.serial(binding.threadKey, async () => {
      const target = parseTarget(`qq:${binding.scope}`), channel = this.opts.getChannel();
      const row = channel.outbox.reserveOutbox({
        key: options.key ?? `${binding.threadKey}:sys:${randomUUID()}`, thread_key: binding.threadKey, turn_id: binding.turnId ?? null,
        input_key: binding.inputKey ?? null, system: true, message_type: target.message_type, target_id: target.target_id,
        mention_user_id: null, text, images, files: [],
      });
      try { return await this.deliver(row, signal); }
      catch (error) {
        if (!isSendRuleError(error)) throw error;
        log.warn("system message rejected by send rules", { thread: binding.threadKey, error: error.message });
        return { ...this.result(channel.outbox.getOutbox(row.key) ?? row, false), note: error.message };
      }
    });
  }

  /** 启动与回合结束时补齐已发出消息的附件及消息库记录；不重发 uncertain 行。 */
  async reconcile(signal?: AbortSignal): Promise<void> {
    for (const row of this.opts.getChannel().outbox.listUnfinishedOutbox()) {
      await this.serial(row.thread_key, () => this.deliver(row, signal)).catch(error =>
        log.warn("outbox reconciliation failed", { key: row.key, error }));
    }
  }

  /**
   * 清理会话 Outbox 目录里一小时前的副本；仍待发送或附件未传完的行引用的文件保留。
   * 回合结束时调用，不影响进行中的发送（新副本不到一小时）。
   */
  async cleanup(threadKey: string, maxAgeMs = 3_600_000): Promise<void> {
    await this.serial(threadKey, async () => {
      const root = path.resolve(attachmentDirs(this.opts.dataDir, threadKey).attachDir, "outbox");
      const stat = await fs.lstat(root).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
      if (!stat) return;
      if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(root) !== root) throw new Error("Outbox 清理目录无效");
      const retained = this.opts.getChannel().outbox.listUnfinishedOutbox().flatMap(row => [...row.images, ...row.files.map(file => file.filename)])
        .map(file => path.resolve(file));
      const now = (this.opts.now ?? Date.now)();
      for (const entry of await fs.readdir(root)) {
        const target = path.resolve(root, entry);
        if (path.dirname(target) !== root) throw new Error("Outbox 清理路径越界");
        if (retained.some(file => file === target || file.startsWith(target + path.sep))) continue;
        const child = await fs.lstat(target);
        if (now - child.mtimeMs < maxAgeMs) continue;
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

  /** 消息库记录：机器人账号取自本轮输入（定时输入取当前登录号），发往输入所在会话时引用该输入。 */
  private recordSent(row: OutboxRow): void {
    const channel = this.opts.getChannel();
    const input = row.input_key ? channel.inbox.getInbound(row.input_key) : null;
    const scope = `${row.message_type}:${row.target_id}`;
    this.opts.store?.recordSent(row, {
      selfId: input?.self_id || channel.status?.().self_id || "",
      replyTo: input?.kind === "user" && input.scope === scope ? input.message_id : null,
    });
  }

  private async deliver(row: OutboxRow, signal?: AbortSignal): Promise<SendResult> {
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
      // 每条消息立即入库；恢复再写是幂等的，引用无需等回合结束。
      try { if (row.message_id) this.recordSent(row); }
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
      if (!result.already_sent) trace.event(row.turn_id ? "turn:" + row.turn_id : "thr:" + row.thread_key, "send_message", { detail: {
        target: `qq:${row.message_type}:${row.target_id}`, key: row.key, system: row.system, message_id: result.message_id,
        text: row.text.slice(0, 500),
        status: result.status, images: row.images.length, files: channel.outbox.getOutbox(row.key)!.files.map(({ name, bytes, status }) => ({ name, bytes, status })),
        already_sent: false } });
    }
  }
}
