import { createReadStream } from 'node:fs';
import { THREAD_ARCHIVE_LIMIT } from '../../agent/thread-archive.js';
import type { ObsStore } from '../store.js';
import { SessionError } from '../sessions/types.js';
import type { ArchiveRow, CompactionRow, MemoryArchives } from './types.js';

function timestamp(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isSafeInteger(n) && n >= 0 && n <= 8.64e15 ? n : null;
}

/** 镜像正常最多 200 行；流式读取并限制总字节，避免异常文件耗尽面板内存。 */
async function archive(file: string | undefined, backend: 'codex' | 'pi'): Promise<ArchiveRow[]> {
  if (!file) return [];
  const rows: ArchiveRow[] = [];
  let pending = '', bytes = 0;
  const parse = (line: string) => {
    if (Buffer.byteLength(line) > 1024 * 1024) throw new SessionError(413, '归档单行超过 1 MiB 读取上限');
    if (!line.trim()) return;
    const r: Record<string, unknown> = JSON.parse(line);
    if (!r || typeof r.key !== 'string' || typeof r.reason !== 'string') throw new Error('归档行无效');
    const id = backend === 'codex' ? r.thread_id : r.conversation;
    if (backend === 'codex' ? typeof id !== 'string' || !id : !Number.isSafeInteger(id) || Number(id) < 0)
      throw new Error('归档会话 ID 无效');
    rows.push({ key: r.key, ...(backend === 'codex' ? { thread_id: id as string } : { conversation: id as number }),
      created_at: timestamp(r.created_at ?? (backend === 'codex' ? r.updated_at : undefined)),
      archived_at: timestamp(r.archived_at), reason: r.reason,
      session_href: `/agents/${backend}/sessions/${encodeURIComponent(String(id))}` });
    if (rows.length > THREAD_ARCHIVE_LIMIT) rows.shift();
  };
  try {
    for await (const chunk of createReadStream(file, { encoding: 'utf8' })) {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 4 * 1024 * 1024) throw new SessionError(413, '归档镜像超过 4 MiB 读取上限');
      pending += chunk;
      let end: number;
      while ((end = pending.indexOf('\n')) !== -1) { parse(pending.slice(0, end)); pending = pending.slice(end + 1); }
      if (Buffer.byteLength(pending) > 1024 * 1024) throw new SessionError(413, '归档单行超过 1 MiB 读取上限');
    }
    parse(pending);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    if (error instanceof SessionError) throw error;
    throw new SessionError(503, '线程归档暂不可读');
  }
  return rows.sort((a, b) => (b.archived_at ?? 0) - (a.archived_at ?? 0));
}

export async function memoryArchives(files: MemoryArchives | undefined, store: ObsStore) {
  const [codex, pi] = await Promise.all([archive(files?.codex, 'codex'), archive(files?.pi, 'pi')]);
  const compactions: CompactionRow[] = [];
  if (!store.degraded) {
    const rows = store.db.prepare(`WITH c AS (
      SELECT ts, json_extract(detail_json,'$.conversation') conversation, json_extract(detail_json,'$.reason') reason
      FROM events WHERE stage='compaction' AND json_valid(detail_json)
        AND (json_extract(detail_json,'$.backend') IS NULL OR json_extract(detail_json,'$.backend')='pi'))
      SELECT conversation, COUNT(*) attempts, MAX(ts) last_at,
        json_group_array(DISTINCT reason) reasons FROM c WHERE conversation IS NOT NULL
      GROUP BY conversation ORDER BY last_at DESC, conversation LIMIT 1001`).all() as
      { conversation: string | number; attempts: number; last_at: number; reasons: string }[];
    if (rows.length > 1000) throw new SessionError(413, '压缩会话数量超过 1000');
    for (const r of rows) compactions.push({ ...r, reasons: (JSON.parse(r.reasons) as unknown[]).filter((v): v is string => typeof v === 'string') });
  }
  return { codex, pi, compactions };
}
