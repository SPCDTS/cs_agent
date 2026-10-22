import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { log } from "../shared/log.js";
import { downloadImage, type DownloadHooks } from "../media/download.js";
import { MAX_IMAGE_BYTES, MIN_IMAGE_BYTES } from "../media/limits.js";
import { validateImageHeader } from "../media/header.js";
import type { Channel, RemoteMessage } from "../channel/types.js";
import type { Access } from "./access.js";
import type { ContextStore, MediaRow, MessageRow } from "./store.js";

export interface RecalledImage { path: string; width: number; height: number }
export interface RecallResult { text: string; images: RecalledImage[] }
interface RecallFlight { work: Promise<RecallResult>; control: AbortController; waiters: number }
export interface MediaRecallOptions {
  store: ContextStore;
  dataDir: string;
  channel: Pick<Channel, "fetchMessage" | "refreshImageUrl"> & Partial<Pick<Channel, "outbox">>;
  downloadHooks?: DownloadHooks;
}

/** 等待也计入截止；超时后的 DNS/API 结果不能继续落盘。 */
export function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}

async function safeDirectory(dir: string, create: boolean): Promise<void> {
  if (create) await fs.mkdir(dir).catch((e: NodeJS.ErrnoException) => { if (e.code !== "EEXIST") throw e; });
  const stat = await fs.lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(dir) !== dir) throw new Error("媒体目录越界或为符号链接");
}

/** 先校验每层父目录，再创建下一层，绝不向链接目标 mkdir。 */
async function mediaRoot(dataDir: string, create: boolean): Promise<string> {
  const data = await fs.realpath(path.resolve(dataDir));
  const root = path.join(data, "media");
  await safeDirectory(root, create);
  return root;
}

export async function readMediaFile(dataDir: string, file: string): Promise<Buffer> {
  const root = await mediaRoot(dataDir, false);
  const rel = path.relative(root, file);
  if (!path.isAbsolute(file) || !/^[a-f0-9]{2}[/\\][a-f0-9]{64}\.(png|jpg|webp|gif)$/.test(rel)) throw new Error("非法媒体路径");
  await safeDirectory(path.dirname(file), false);
  const st = await fs.lstat(file);
  if (!st.isFile() || st.isSymbolicLink() || st.size < MIN_IMAGE_BYTES || st.size > MAX_IMAGE_BYTES ||
      await fs.realpath(file) !== file) throw new Error("媒体文件不安全");
  const bytes = await fs.readFile(file);
  validateImageHeader(bytes);
  if (createHash("sha256").update(bytes).digest("hex") !== path.basename(file).split(".")[0]) throw new Error("媒体文件内容不一致");
  return bytes;
}

async function saveFile(dataDir: string, bytes: Buffer, signal: AbortSignal): Promise<{ path: string; sha256: string }> {
  if (bytes.length < MIN_IMAGE_BYTES || bytes.length > MAX_IMAGE_BYTES) throw new Error("媒体大小须为 12 B–10 MiB");
  validateImageHeader(bytes);
  signal.throwIfAborted();
  const root = await mediaRoot(dataDir, true);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const dir = path.join(root, sha256.slice(0, 2));
  await safeDirectory(dir, true);
  const ext = bytes[0] === 0x89 ? "png" : bytes[0] === 0xff ? "jpg" : bytes.toString("ascii", 0, 4) === "RIFF" ? "webp" : "gif";
  const file = path.join(dir, sha256 + "." + ext);
  signal.throwIfAborted();
  const temp = path.join(dir, "." + sha256 + "." + randomBytes(16).toString("hex") + ".tmp");
  try {
    await fs.writeFile(temp, bytes, { flag: "wx", mode: 0o600 });
    const written = await fs.readFile(temp);
    validateImageHeader(written);
    if (!written.equals(bytes)) throw new Error("媒体临时文件内容不一致");
    signal.throwIfAborted();
    try { await fs.link(temp, file); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      // 已有路径仍必须是安全的普通文件；只替换损坏内容，不替换链接或目录。
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || await fs.realpath(file) !== file) throw new Error("媒体文件不安全");
      let intact = false;
      try { intact = (await readMediaFile(dataDir, file)).equals(bytes); }
      catch (error) { if ((error as NodeJS.ErrnoException).code) throw error; }
      signal.throwIfAborted();
      if (intact) {
        const now = new Date();
        await fs.utimes(file, now, now);
      } else await fs.rename(temp, file);
    }
  } finally {
    await fs.unlink(temp).catch((err: NodeJS.ErrnoException) => { if (err.code !== "ENOENT") throw err; });
  }
  return { path: file, sha256 };
}

/** 使用真实段定位占位，用户手写的 [image] 不会被误替换。 */
export function recalledText(row: MessageRow, segments: RemoteMessage["segments"], media: MediaRow[]): string {
  const paths = new Map(media.filter(m => m.status === "ok" && m.path).map(m => [m.ordinal, m.path!]));
  if (row.is_self || segments.map(s => s.rendered).join("").slice(0, 16000) !== row.text) {
    return row.text + [...paths.values()].map(p => " [image:" + p + "]").join("");
  }
  let offset = 0, ordinal = 0;
  const parts: string[] = [];
  for (const segment of segments) {
    const original = segment.rendered;
    const remaining = Math.max(0, 16000 - offset);
    if (segment.type === "image") {
      const file = paths.get(++ordinal);
      parts.push(file && remaining >= original.length ? "[image:" + file + "]" : original.slice(0, remaining));
    } else parts.push(original.slice(0, remaining));
    offset += original.length;
  }
  return parts.join("");
}

/** 仅按需调用：同消息合并，全局最多两个任务，含排队总时限 60 秒。 */
export class MediaRecall {
  private readonly pending = new Map<string, RecallFlight>();
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  constructor(private readonly opts: MediaRecallOptions) {}

  async recall(access: Access, messageId: string, callerSignal?: AbortSignal): Promise<RecallResult> {
    callerSignal?.throwIfAborted();
    const hit = this.opts.store.message(access, messageId);
    if (!hit) throw new Error("没有这条消息，或不在当前会话范围内");
    const row = hit.row;
    const key = JSON.stringify([row.scope, messageId]);
    let flight = this.pending.get(key);
    if (!flight) {
      const control = new AbortController();
      const signal = AbortSignal.any([AbortSignal.timeout(60_000), control.signal]);
      const created: RecallFlight = { control, waiters: 0, work: abortable(this.run(row, signal), signal).finally(() => {
        if (this.pending.get(key) === created) this.pending.delete(key);
      }) };
      this.pending.set(key, created);
      flight = created;
    }
    flight.waiters++;
    try { return await (callerSignal ? abortable(flight.work, callerSignal) : flight.work); }
    finally {
      if (--flight.waiters === 0) {
        if (this.pending.get(key) === flight) this.pending.delete(key);
        flight.control.abort(new Error("召回已无等待者"));
      }
    }
  }

  async view(access: Access, file: string): Promise<{ type: "image"; data: string; mimeType: string }> {
    if (!this.opts.store.mediaPathAllowed(access, file)) throw new Error("图片不在当前会话范围内");
    const bytes = await readMediaFile(this.opts.dataDir, file);
    if (bytes.length > MAX_IMAGE_BYTES) throw new Error("图片超过 10 MiB");
    const mimeType = file.endsWith(".jpg") ? "image/jpeg" : "image/" + path.extname(file).slice(1);
    return { type: "image", data: bytes.toString("base64"), mimeType };
  }

  private async acquire(signal: AbortSignal): Promise<void> {
    if (this.active < 2) { this.active++; return; }
    await new Promise<void>((resolve, reject) => {
      const ready = () => { signal.removeEventListener("abort", abort); resolve(); };
      const abort = () => {
        const i = this.waiting.indexOf(ready);
        if (i >= 0) this.waiting.splice(i, 1);
        reject(signal.reason);
      };
      signal.throwIfAborted();
      this.waiting.push(ready);
      signal.addEventListener("abort", abort, { once: true });
    });
  }

  private stillPresent(row: MessageRow): void {
    const current = this.opts.store.message({ kind: "scope", scope: row.scope }, row.message_id)?.row;
    if (!current || current.id !== row.id || current.text !== row.text) throw new Error("消息已撤回或变更");
  }

  private checkScope(row: MessageRow, remote: RemoteMessage | null): void {
    const reject = () => {
      log.warn("media recall scope mismatch", { scope: row.scope, message_id: row.message_id });
      throw new Error("原消息不在当前会话范围内");
    };
    if (!remote) return reject();
    const [kind, id] = row.scope.split(":");
    if (remote.message_type !== kind) return reject();
    if (kind === "group" && remote.group_id !== id) return reject();
    const sender = remote.sender_id;
    if (remote.sender_conflict) return reject();
    if (remote.message_id && remote.message_id !== row.message_id) return reject();
    if (!row.is_self) {
      if (kind === "private" && sender !== id) return reject();
      return;
    }
    if (!row.outbox_key) return reject();
    // 机器人消息只认 Outbox 行（键即消息库 outbox_key 列）：必须确认已发出且发出账号一致；旧版只留在票据表里的回复一律拒绝。
    const outbox = this.opts.channel.outbox?.getOutbox(row.outbox_key);
    if (!outbox || outbox.status !== "sent" || outbox.message_id !== row.message_id || outbox.message_type + ":" + outbox.target_id !== row.scope ||
        !row.user_id || sender !== row.user_id) return reject();
    // NapCat 各版本的可选收件人字段；出现时必须与本地记录的会话一致。
    for (const recipient of Object.values(remote.recipient_fields)) {
      if (recipient !== id) return reject();
    }
    if (kind === "private" && remote.has_nonempty_group_field) return reject();
  }

  private async result(media: MediaRow[], signal: AbortSignal): Promise<RecallResult> {
    const images: RecalledImage[] = [], lines: string[] = [];
    for (const m of media) {
      signal.throwIfAborted();
      if (m.status === "ok" && m.path) {
        const dimensions = validateImageHeader(await readMediaFile(this.opts.dataDir, m.path));
        images.push({ path: m.path, ...dimensions });
        lines.push("图" + m.ordinal + ": " + m.path + "（" + dimensions.width + "×" + dimensions.height + "）");
      } else lines.push("图" + m.ordinal + ": 不可用（" + m.reason + "）");
    }
    return { text: lines.join("\n") || "这条消息没有图片", images };
  }

  private async run(row: MessageRow, signal: AbortSignal): Promise<RecallResult> {
    await this.acquire(signal);
    try {
      signal.throwIfAborted();
      this.stillPresent(row);
      const cached = this.opts.store.media(row.scope, row.message_id);
      if (cached.some(m => m.status === "ok")) return await this.result(cached, signal);
      if (row.is_self ? !row.image_count : !row.text.includes("[image]")) return { text: "这条消息没有图片", images: [] };
      const remote = await abortable(this.opts.channel.fetchMessage(row.message_id, { signal, timeoutMs: 60_000 }), signal);
      this.checkScope(row, remote);
      this.stillPresent(row);
      const segments = remote?.segments ?? [];
      const pictures = segments.filter(s => s.type === "image").slice(0, 6);
      const media: MediaRow[] = [];
      for (const [i, segment] of pictures.entries()) {
        const m: MediaRow = { scope: row.scope, message_id: row.message_id, ordinal: i + 1,
          path: null, sha256: null, status: "skipped", reason: null, created_at: Math.floor(Date.now() / 1000) };
        try {
          const { file, url } = segment.image ?? { file: "", url: "" };
          let bytes: Buffer;
          try { bytes = await abortable(downloadImage(url, signal, this.opts.downloadHooks), signal); }
          catch (err) {
            signal.throwIfAborted();
            if (!file) throw err;
            const fresh = await abortable(this.opts.channel.refreshImageUrl(file, { signal }), signal);
            if (!fresh || fresh === url) throw err;
            bytes = await abortable(downloadImage(fresh, signal, this.opts.downloadHooks), signal);
          }
          signal.throwIfAborted();
          this.stillPresent(row);
          Object.assign(m, await saveFile(this.opts.dataDir, bytes, signal), { status: "ok" });
        } catch (err) {
          signal.throwIfAborted();
          m.reason = (err as Error).message.slice(0, 160);
        }
        media.push(m);
      }
      signal.throwIfAborted();
      this.opts.store.saveMedia(row, media, recalledText(row, segments, media));
      return await this.result(media, signal);
    } finally {
      const next = this.waiting.shift();
      if (next) next(); else this.active--;
    }
  }
}

/** 不跟随链接，仅回收一天前且已无媒体行引用的内容文件。 */
export async function cleanupMedia(dataDir: string, store: ContextStore, now = Date.now()): Promise<number> {
  const candidate = path.join(await fs.realpath(dataDir), "media");
  if (!await fs.lstat(candidate).catch((e: NodeJS.ErrnoException) => { if (e.code !== "ENOENT") throw e; return undefined; })) return 0;
  const root = await mediaRoot(dataDir, false);
  let removed = 0;
  for (const shard of await fs.readdir(root, { withFileTypes: true })) {
    if (!shard.isDirectory() || shard.isSymbolicLink() || !/^[a-f0-9]{2}$/.test(shard.name)) continue;
    const dir = path.join(root, shard.name);
    await safeDirectory(dir, false);
    for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
      const temporary = /^\.[a-f0-9]{64}\.[a-f0-9]+\.tmp$/.test(ent.name);
      if (!ent.isFile() || ent.isSymbolicLink() || (!temporary && !/^[a-f0-9]{64}\.(png|jpg|webp|gif)$/.test(ent.name))) continue;
      const file = path.join(dir, ent.name);
      const stat = await fs.lstat(file).catch((err: NodeJS.ErrnoException) => { if (err.code !== "ENOENT") throw err; });
      if (stat?.isFile() && !stat.isSymbolicLink() && stat.mtimeMs < now - 86400_000 && (temporary || !store.mediaPathReferenced(file))) {
        const deleted = await fs.unlink(file).then(() => true, (err: NodeJS.ErrnoException) => { if (err.code !== "ENOENT") throw err; return false; });
        if (deleted) removed++;
      }
    }
  }
  return removed;
}
