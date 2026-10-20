/** 附件只登记本地副本；实际发送由回复阶段负责。媒体归属由上层回调校验。 */
import { createHash, randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { collectNewImages } from "./gen/image-collect.js";
import { isSupportedImage, MAX_IMAGES, MIN_IMAGE_BYTES, MAX_IMAGE_BYTES, MAX_TOTAL_IMAGE_BYTES } from "./limits.js";

export const DEFAULT_FILE_DENY_EXT = [".exe", ".bat", ".cmd", ".ps1", ".vbs", ".js", ".scr", ".msi", ".com", ".lnk"];
export interface AttachmentLimits { maxBytes: number; maxFiles: number; denyExtensions: readonly string[] }
export const DEFAULT_ATTACHMENT_LIMITS: AttachmentLimits = { maxBytes: 20 * 1024 * 1024, maxFiles: 3, denyExtensions: DEFAULT_FILE_DENY_EXT };
export interface AttachmentSource {
  path: string;
  workdir: string;
  /** 额外的只读来源根目录，与工作区执行相同的路径校验。 */
  extraRoots?: string[];
  mediaCheck?: (canonical: string) => boolean | Promise<boolean>;
}
export interface FileAttachment {
  originalPath: string;
  filename: string;
  name: string;
  bytes: number;
  sha256: string;
  source: "workspace" | "generated" | "media";
}
const SOURCE_ERROR = "只能发送工作区内的文件或已召回的图片";
const digest = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const inside = (root: string, file: string) => {
  const rel = path.relative(root, file);
  return !!rel && rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel);
};

/** 连父目录中的软链接也拒绝，防止指向同一工作区内的链接绕过限制。 */
async function noSymlinks(file: string): Promise<void> {
  for (let current = path.resolve(file); ; current = path.dirname(current)) {
    if ((await fs.lstat(current)).isSymbolicLink()) throw new Error(SOURCE_ERROR + "（不允许软链接）");
    if (path.dirname(current) === current) return;
  }
}

async function readBounded(file: string, min: number, max: number): Promise<Buffer> {
  await noSymlinks(file);
  const before = await fs.lstat(file);
  // FIFO/设备必须在 open 前拒绝，避免以只读方式打开管道时等待写入端。
  if (!before.isFile() || before.size < min || before.size > max) throw new Error(`附件必须为 ${min} B～${max / 1024 / 1024} MiB 的普通文件`);
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < min || stat.size > max || stat.dev !== before.dev || stat.ino !== before.ino) throw new Error(`附件必须为 ${min} B～${max / 1024 / 1024} MiB 的普通文件`);
    // 有界读取：读取期间增长的文件不能令内存无上限膨胀，也不能绕过大小限制。
    const buffer = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== stat.size) throw new Error("附件读取期间发生变化，请重试");
    return buffer.subarray(0, offset);
  } finally { await handle.close(); }
}

async function sourceFile(o: AttachmentSource, min: number, max: number) {
  if (!o.path || /^[a-z][a-z0-9+.-]*:\/\//i.test(o.path)) throw new Error(SOURCE_ERROR);
  const file = path.resolve(o.workdir, o.path);
  try { await noSymlinks(file); } catch { throw new Error(SOURCE_ERROR + "（文件不存在或含软链接）"); }
  const canonical = await fs.realpath(file);
  const root = await fs.realpath(o.workdir);
  let source: FileAttachment["source"] | undefined = inside(root, canonical) && inside(path.resolve(o.workdir), file) ? "workspace" : undefined;
  if (!source) {
    for (const extraRoot of o.extraRoots ?? []) {
      if (!inside(path.resolve(extraRoot), file)) continue;
      try {
        if (inside(await fs.realpath(extraRoot), canonical)) { source = "generated"; break; }
      } catch { /* 缺失或不可访问的来源根目录不扩大白名单。 */ }
    }
  }
  if (!source) {
    try { if (await o.mediaCheck?.(canonical)) source = "media"; }
    catch { /* 媒体库不可用或内容失效均不扩大来源白名单。 */ }
  }
  if (!source) throw new Error(SOURCE_ERROR);
  const data = await readBounded(file, min, max);
  if (await fs.realpath(file) !== canonical) throw new Error(SOURCE_ERROR);
  return { data, canonical, source, sha256: digest(data) };
}

/** 两种路径分隔符都按 basename 处理，截断保留扩展名，阻止尾点/空格与控制字符绕过黑名单。 */
export function attachmentName(raw: string): string {
  let name = path.posix.basename(raw.replace(/\\/g, "/")).replace(/[\x00-\x1f\x7f-\x9f<>:"|?*]/g, "").trim().replace(/[. ]+$/, "");
  if (!name || name === "." || name === "..") throw new Error("附件文件名无效");
  const ext = path.extname(name);
  if (Array.from(name).length > 120) {
    if (Array.from(ext).length >= 120) throw new Error("附件扩展名过长");
    name = Array.from(name.slice(0, name.length - ext.length)).slice(0, 120 - Array.from(ext).length).join("") + ext;
  }
  return name;
}

// 同一票据的并行工具调用串行登记，数量校验和 manifest 更新属于同一临界区。
const queues = new Map<string, Promise<unknown>>();
async function serial<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(dir);
  const task = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(fn);
  queues.set(key, task);
  try { return await task; } finally { if (queues.get(key) === task) queues.delete(key); }
}

export async function readFileAttachments(fileDir: string): Promise<FileAttachment[]> {
  const file = path.join(fileDir, "manifest.json");
  let data: Buffer;
  try { data = await readBounded(file, 1, 1024 * 1024); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const rows: unknown = JSON.parse(data.toString("utf8"));
  if (!Array.isArray(rows) || rows.some((row, index) => !row || typeof row.originalPath !== "string" ||
    typeof row.name !== "string" || attachmentName(row.name) !== row.name || row.filename !== `${index + 1}-${row.name}` ||
    !Number.isSafeInteger(row.bytes) || row.bytes < 1 || !/^[a-f0-9]{64}$/.test(row.sha256) ||
    !["workspace", "generated", "media"].includes(row.source))) throw new Error("附件 manifest 格式无效");
  return rows as FileAttachment[];
}

/** 回复阶段只读副本，验证内容与登记时一致；不再读取原始路径。 */
export async function readAttachmentData(fileDir: string, entry: FileAttachment): Promise<Buffer> {
  if (path.basename(entry.filename) !== entry.filename || /[\\/]/.test(entry.filename)) throw new Error("附件副本路径无效");
  const data = await readBounded(path.join(fileDir, entry.filename), entry.bytes, entry.bytes);
  if (digest(data) !== entry.sha256) throw new Error("附件副本校验失败");
  return data;
}

export async function registerFileAttachment(o: AttachmentSource & { name?: string; fileDir: string; limits?: AttachmentLimits }): Promise<string> {
  const limits = o.limits ?? DEFAULT_ATTACHMENT_LIMITS;
  const name = attachmentName(o.name ?? o.path);
  if (limits.denyExtensions.map(ext => ext.trim().toLowerCase()).includes(path.extname(name).toLowerCase())) throw new Error("不允许发送此扩展名的文件");
  const source = await sourceFile(o, 1, limits.maxBytes);
  return serial(o.fileDir, async () => {
    await fs.mkdir(o.fileDir, { recursive: true });
    await noSymlinks(o.fileDir);
    const rows = await readFileAttachments(o.fileDir);
    let index = rows.findIndex(row => row.sha256 === source.sha256);
    if (index < 0) {
      if (rows.length >= limits.maxFiles) throw new Error(`每次回复最多 ${limits.maxFiles} 个文件`);
      index = rows.length;
      const filename = `${index + 1}-${name}`;
      // 崩溃留下的未登记副本可安全替换；已登记副本从不重写。
      const tmp = path.join(o.fileDir, `.attach-${randomUUID()}.tmp`);
      await fs.writeFile(tmp, source.data, { flag: "wx" });
      await fs.rename(tmp, path.join(o.fileDir, filename));
      rows.push({ originalPath: source.canonical, filename, name, bytes: source.data.length, sha256: source.sha256, source: source.source });
      const manifestTmp = path.join(o.fileDir, `.manifest-${randomUUID()}.tmp`);
      await fs.writeFile(manifestTmp, JSON.stringify(rows, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
      await fs.rename(manifestTmp, path.join(o.fileDir, "manifest.json"));
    }
    return `已登记，将随回复发送（第 ${index + 1}/${limits.maxFiles} 个，${(rows[index]!.bytes / 1024 / 1024).toFixed(2)} MiB）`;
  });
}

export async function registerImageAttachment(o: AttachmentSource & { attachDir: string }): Promise<string> {
  const source = await sourceFile(o, MIN_IMAGE_BYTES, MAX_IMAGE_BYTES);
  if (!isSupportedImage(source.data)) throw new Error("仅支持 PNG、JPEG、WebP、GIF 图片");
  return serial(o.attachDir, async () => {
    await fs.mkdir(o.attachDir, { recursive: true });
    await noSymlinks(o.attachDir);
    const images = await collectNewImages(o.attachDir, new Set(), Number.MAX_SAFE_INTEGER);
    let total = 0;
    for (const [index, image] of images.entries()) {
      const data = await readBounded(image, MIN_IMAGE_BYTES, MAX_IMAGE_BYTES);
      total += data.length;
      if (digest(data) === source.sha256) return `已登记，将随回复发送（第 ${index + 1}/${MAX_IMAGES} 张）`;
    }
    if (images.length >= MAX_IMAGES) throw new Error(`每次回复最多 ${MAX_IMAGES} 张图（含生图）`);
    if (total + source.data.length > MAX_TOTAL_IMAGE_BYTES) throw new Error("每次回复图片合计不超过 20 MiB");
    let n = 1;
    let dir: string;
    for (;;) {
      dir = path.join(o.attachDir, `attach-${n++}`);
      try { await fs.mkdir(dir); break; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
    await fs.writeFile(path.join(dir, attachmentName(o.path)), source.data, { flag: "wx" });
    return `已登记，将随回复发送（第 ${images.length + 1}/${MAX_IMAGES} 张）`;
  });
}

/** send_message 与旧附件登记共用来源、符号链接、大小、格式及扩展名校验。 */
export async function prepareSendAttachments(source: Omit<AttachmentSource, "path">,
  args: { images?: string[]; files?: { path: string; name?: string }[] }, limits = DEFAULT_ATTACHMENT_LIMITS) {
  const images = [];
  let total = 0;
  for (const file of args.images ?? []) {
    const image = await sourceFile({ ...source, path: file }, MIN_IMAGE_BYTES, MAX_IMAGE_BYTES);
    if (!isSupportedImage(image.data)) throw new Error("仅支持 PNG、JPEG、WebP、GIF 图片");
    total += image.data.length;
    if (total > MAX_TOTAL_IMAGE_BYTES) throw new Error("每次回复图片合计不超过 20 MiB");
    images.push(image);
  }
  const files = [];
  if ((args.files?.length ?? 0) > Math.min(3, limits.maxFiles)) throw new Error("文件数量超过限制");
  for (const file of args.files ?? []) {
    const name = attachmentName(file.name ?? file.path);
    if (limits.denyExtensions.map(ext => ext.trim().toLowerCase()).includes(path.extname(name).toLowerCase())) throw new Error("不允许发送此扩展名的文件");
    files.push({ ...await sourceFile({ ...source, path: file.path }, 1, Math.min(20 * 1024 * 1024, limits.maxBytes)), name });
  }
  return { images, files };
}
