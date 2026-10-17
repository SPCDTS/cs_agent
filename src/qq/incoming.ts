import { promises as fs } from "node:fs";
import path from "node:path";
import { isSupportedImage, MAX_IMAGE_BYTES, MIN_IMAGE_BYTES } from "./image.js";
import { isRecord, stringField, type OneBotClient } from "./onebot.js";

export const INCOMING_RETENTION_MS = 7 * 86400_000;
const httpUrl = (value: string) => /^https?:\/\//i.test(value);

async function download(url: string): Promise<Buffer> {
  if (!httpUrl(url)) throw new Error("参考图没有可下载的 HTTP URL");
  // 图片 CDN 不需要也不能收到 NapCat Bearer token；不读取消息携带的本机路径。
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok || !res.body) throw new Error("参考图下载失败");
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    if (Number(res.headers.get("content-length")) > MAX_IMAGE_BYTES) throw new Error("参考图超过 10 MiB");
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > MAX_IMAGE_BYTES) throw new Error("参考图超过 10 MiB");
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => undefined); }
  const bytes = Buffer.concat(chunks);
  if (bytes.length < MIN_IMAGE_BYTES || !isSupportedImage(bytes)) throw new Error("参考图魔数无效，仅支持 PNG/JPEG/WebP/GIF");
  return bytes;
}

/** 仅由 bridge 在授权、触发、去重检查之后调用；原始 URL 不进入持久化票据或日志。 */
export async function downloadIncoming(event: Record<string, unknown>, ticket: string, dataDir: string, client: OneBotClient): Promise<string[]> {
  if (!/^[a-f0-9]{64}$/.test(ticket)) throw new Error("非法票据");
  const segments = (Array.isArray(event.message) ? event.message : []).filter(s => isRecord(s) && s.type === "image");
  if (segments.length > 3) throw new Error("参考图最多 3 张");
  const dir = path.resolve(dataDir, "incoming", ticket);
  const result: string[] = [];
  for (const [i, segment] of segments.entries()) {
    const data = isRecord(segment.data) ? segment.data : {};
    const file = stringField(data, "file");
    let bytes: Buffer;
    const url = stringField(data, "url") || (httpUrl(file) ? file : "");
    try { bytes = await download(url); }
    catch (err) {
      // URL 失效或缺失时让 NapCat 刷新；file 可能只是文件名，绝不直接读宿主机路径。
      if (!file) throw err;
      const info = await client.call("get_image", { file });
      const fresh = stringField(info, "url");
      if (!fresh || fresh === url) throw err;
      bytes = await download(fresh);
    }
    await fs.mkdir(dir, { recursive: true });
    const root = await fs.realpath(path.resolve(dataDir));
    const real = await fs.realpath(dir);
    if (path.relative(root, real) !== path.join("incoming", ticket)) throw new Error("参考图目录越界");
    const extension = bytes[0] === 0x89 ? "png" : bytes[0] === 0xff ? "jpg" : bytes.toString("ascii", 0, 4) === "RIFF" ? "webp" : "gif";
    const dest = path.join(dir, `${i + 1}.${extension}`);
    await fs.writeFile(dest, bytes, { flag: "wx" }).catch(async err => {
      if (err.code !== "EEXIST") throw err;
      // admit 前崩溃的完整文件可复用；不同字节则拒绝，避免覆盖本地路径。
      if (!(await fs.readFile(dest)).equals(bytes)) throw new Error("参考图恢复文件不一致");
    });
    result.push(dest);
  }
  return result;
}

/** 只清理 incoming 的票据子目录，不跟随符号链接；以目录 mtime 计算 7 天保留期。 */
export async function cleanupIncoming(dataDir: string, now = Date.now()): Promise<number> {
  const root = path.resolve(dataDir, "incoming");
  if ((await fs.lstat(root).catch(() => undefined))?.isSymbolicLink()) throw new Error("incoming 不能是符号链接");
  let removed = 0;
  for (const ent of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!ent.isDirectory() || ent.isSymbolicLink() || !/^[a-f0-9]{64}$/.test(ent.name)) continue;
    const dir = path.resolve(root, ent.name);
    if (path.dirname(dir) !== root) throw new Error("清理目录越界");
    if ((await fs.lstat(dir)).mtimeMs < now - INCOMING_RETENTION_MS) {
      await fs.rm(dir, { recursive: true, force: true });
      removed++;
    }
  }
  return removed;
}
