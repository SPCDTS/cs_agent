import { withoutImagePaths } from '../../context/format.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { ContextStore, MediaRow } from '../../context/store.js';
import { readMediaFile } from '../../context/media.js';
import { SessionError } from '../sessions/types.js';
import { preview } from './read.js';
import type { ImageDetail, ImageItem, ImagePage } from './types.js';

export interface ImageFilters { scope?: string; status?: 'ok' | 'skipped'; since?: number; page: number }
const SHA = /^[a-f0-9]{64}$/i;
const EXTENSIONS = ['png', 'jpg', 'gif', 'webp'];
type ImageRow = MediaRow & { message_ts: number; sender_name: string; text: string };
const SELECT = `SELECT mm.*, m.time*1000 message_ts, m.nickname sender_name, m.text
  FROM message_media mm JOIN messages m ON m.scope=mm.scope AND m.message_id=mm.message_id`;

/** 只检查已登记路径的元数据；目录、分片和文件均不得是链接，不读取图片正文。 */
async function metadata(dataDir: string, row: MediaRow): Promise<{ present: boolean; bytes: number | null }> {
  const absent = { present: false, bytes: null };
  if (!row.path || !row.sha256 || !SHA.test(row.sha256)) return absent;
  try {
    const root = path.join(await fs.realpath(dataDir), 'media');
    const dir = path.join(root, row.sha256.slice(0, 2));
    if (!EXTENSIONS.some(ext => row.path === path.join(dir, `${row.sha256}.${ext}`))) return absent;
    for (const parent of [root, dir]) {
      const st = await fs.lstat(parent);
      if (!st.isDirectory() || st.isSymbolicLink() || await fs.realpath(parent) !== parent) return absent;
    }
    const st = await fs.lstat(row.path);
    if (!st.isFile() || st.isSymbolicLink() || await fs.realpath(row.path) !== row.path) return absent;
    return { present: true, bytes: st.size };
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return absent;
    throw error;
  }
}

export class ImageReader {
  private readonly db: DatabaseSync;
  private readonly dataDir: string;
  constructor(context: ContextStore) {
    this.dataDir = path.dirname(context.file);
    this.db = new DatabaseSync(context.file, { readOnly: true });
    this.db.exec('PRAGMA busy_timeout=5000; BEGIN;');
  }
  close(): void { this.db.close(); }

  private async item(row: ImageRow): Promise<ImageItem> {
    const meta = await metadata(this.dataDir, row);
    const href = meta.present && row.status === 'ok' ? `/media/${row.sha256}` : null;
    return { scope: row.scope, message_id: row.message_id, ordinal: row.ordinal, status: row.status,
      sha256: row.sha256, ...meta, mime: null, width: null, height: null, message_ts: row.message_ts,
      sender_name: preview(row.sender_name, 256), excerpt: preview(withoutImagePaths(row.text), 120), thumb_href: href, href };
  }

  async list(f: ImageFilters): Promise<ImagePage> {
    const clauses: string[] = [], args: SQLInputValue[] = [];
    if (f.scope !== undefined) { clauses.push('mm.scope=?'); args.push(f.scope); }
    if (f.status !== undefined) { clauses.push('mm.status=?'); args.push(f.status); }
    if (f.since !== undefined) { clauses.push('m.time>=?'); args.push(f.since / 1000); }
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db.prepare(`${SELECT}${where} ORDER BY m.time DESC, m.id DESC, mm.ordinal ASC LIMIT 51 OFFSET ?`)
      .all(...args, f.page * 50) as unknown as ImageRow[];
    const totals = { ok: 0, skipped: 0, bytes: 0 };
    // 逐行聚合文件元数据，不把全部消息正文加载到内存；同一文件按媒体记录计数。
    for (const raw of this.db.prepare(`SELECT mm.* FROM message_media mm JOIN messages m
      ON m.scope=mm.scope AND m.message_id=mm.message_id${where}`).iterate(...args)) {
      const row = raw as unknown as MediaRow;
      totals[row.status]++;
      totals.bytes += (await metadata(this.dataDir, row)).bytes ?? 0;
    }
    return { items: await Promise.all(rows.slice(0, 50).map(row => this.item(row))), page: f.page, has_more: rows.length > 50, totals };
  }

  async detail(scope: string, messageId: string, ordinal: number): Promise<ImageDetail> {
    const rows = this.db.prepare(`${SELECT} WHERE mm.scope=? AND mm.message_id=? ORDER BY mm.ordinal`)
      .all(scope, messageId) as unknown as ImageRow[];
    const row = rows.find(r => r.ordinal === ordinal);
    if (!row) throw new SessionError(404, '图片记录不存在');
    const item = await this.item(row);
    const q = new URLSearchParams({ from: String(Math.max(0, row.message_ts - 3600_000)), to: String(row.message_ts + 3600_000) });
    return { item, message: { scope, message_id: messageId, ts: row.message_ts, sender_name: item.sender_name,
      excerpt: preview(withoutImagePaths(row.text), 120) }, other_media: await Promise.all(rows.filter(r => r.ordinal !== ordinal).map(r => this.item(r))),
      timeline_href: `/memory/scopes/${encodeURIComponent(scope)}?${q}#messages` };
  }
}

export function imageMime(bytes: Buffer): string | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (/^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6))) return 'image/gif';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** 只有已登记的内容寻址文件才能进入受控读取；无召回器或网络依赖。 */
export async function imageBinary(dataDir: string, store: Pick<ContextStore, 'mediaPathReferenced'>, sha: string) {
  if (!SHA.test(sha)) throw new SessionError(400, 'sha256 必须是 64 位十六进制');
  sha = sha.toLowerCase();
  let root: string;
  try { root = path.join(await fs.realpath(dataDir), 'media', sha.slice(0, 2)); }
  catch { throw new SessionError(404, '图片不存在'); }
  for (const ext of EXTENSIONS) {
    const file = path.join(root, `${sha}.${ext}`);
    if (!store.mediaPathReferenced(file)) continue;
    try {
      const bytes = await readMediaFile(dataDir, file), mime = imageMime(bytes);
      if (!mime) throw new SessionError(415, '不支持的图片格式');
      return { bytes, mime };
    } catch (error) {
      // readMediaFile 自身先校验魔数；不为判型绕过其路径、链接和摘要校验。
      if (error instanceof SessionError || (error as Error).message === '参考图魔数无效，仅支持 PNG/JPEG/WebP/GIF')
        throw new SessionError(415, '不支持的图片格式');
    }
  }
  throw new SessionError(404, '图片不存在或已清理');
}
