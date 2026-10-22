import { downloadImage, type DownloadHooks } from '../media/download.js';
import { promises as fs } from "node:fs";
import path from "node:path";
import { MAX_IMAGE_BYTES, MIN_IMAGE_BYTES } from "../media/limits.js";
import { isRecord, stringField, type OneBotClient } from "./onebot.js";

export const INCOMING_RETENTION_MS = 7 * 86400_000;
const httpUrl = (value: string) => /^https?:\/\//i.test(value);

/** 仅由 bridge 在授权、触发、去重检查之后调用；URL/file 元数据仅进入 Inbox 记录（恢复用），不进入日志。 */
export async function downloadIncoming(event: Record<string, unknown>, key: string, dataDir: string, client: OneBotClient, signal = AbortSignal.timeout(60_000), hooks: DownloadHooks = {}): Promise<string[]> {
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("非法入站键");
  const segments = (Array.isArray(event.message) ? event.message : []).filter(s => isRecord(s) && s.type === "image");
  if (segments.length > 3) throw new Error("参考图最多 3 张");
  const root = await fs.realpath(path.resolve(dataDir));
  const parent = path.join(root, 'incoming');
  // 先校验父目录，绝不先向越界链接内 mkdir 输入目录。
  await fs.mkdir(parent).catch(err => { if (err.code !== 'EEXIST') throw err; });
  if (await fs.realpath(parent) !== parent) throw new Error('参考图目录越界');
  const dir = path.join(parent, key);
  const result: string[] = [];
  for (const [i, segment] of segments.entries()) {
    const data = isRecord(segment.data) ? segment.data : {};
    const file = stringField(data, "file");
    let bytes: Buffer;
    const url = stringField(data, "url") || (httpUrl(file) ? file : "");
    try { bytes = await downloadImage(url, signal, hooks); }
    catch (err) {
      // URL 失效或缺失时让 NapCat 刷新；file 可能只是文件名，绝不直接读宿主机路径。
      signal.throwIfAborted();
      if (!file) throw err;
      const info = await client.call("get_image", { file });
      const fresh = stringField(info, "url");
      if (!fresh || fresh === url) throw err;
      bytes = await downloadImage(fresh, signal, hooks);
    }
    signal.throwIfAborted();
    if (await fs.realpath(parent) !== parent) throw new Error('参考图目录越界');
    await fs.mkdir(dir).catch(err => { if (err.code !== 'EEXIST') throw err; });
    const real = await fs.realpath(dir);
    if (path.relative(root, real) !== path.join("incoming", key)) throw new Error("参考图目录越界");
    const extension = bytes[0] === 0x89 ? "png" : bytes[0] === 0xff ? "jpg" : bytes.toString("ascii", 0, 4) === "RIFF" ? "webp" : "gif";
    const dest = path.join(dir, `${i + 1}.${extension}`);
    await fs.writeFile(dest, bytes, { flag: "wx" }).catch(async err => {
      if (err.code !== "EEXIST") throw err;
      // 恢复前先 lstat，禁止链接、设备及超大文件。
      const stat = await fs.lstat(dest);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size < MIN_IMAGE_BYTES || stat.size > MAX_IMAGE_BYTES) throw new Error('参考图恢复文件不安全');
      if (!(await fs.readFile(dest)).equals(bytes)) throw new Error("参考图恢复文件不一致");
    });
    result.push(dest);
  }
  return result;
}

/** 只清理 incoming 下按入站键命名的子目录，不跟随符号链接；以目录 mtime 计算 7 天保留期。 */
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
