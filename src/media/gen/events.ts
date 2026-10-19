import { appendFileSync, lstatSync, readFileSync, constants, openSync, closeSync, fstatSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ObsEvent } from '../../shared/trace.js';
import { trace, type Trace } from '../../shared/trace.js';

export const IMAGE_EVENT_BYTES = 256 * 1024;
const IMAGE_EVENT_LINES = 200;
const filename = 'obs-events.jsonl';
const schema = z.object({
  ts: z.number().finite().nonnegative(), stage: z.enum(['image:submit','image:collect','recovered']),
  status: z.enum(['started','ok','failed']), duration_ms: z.number().finite().nonnegative().nullable(),
  detail: z.record(z.string(), z.unknown()),
}).strict();

/** 子进程仅写票据旁路文件；失败由 Trace 隔离，不打开任何数据库。 */
export class ImageEventSpool {
  constructor(private dir: string) {}
  append(e: Omit<ObsEvent,'id'|'detail_json'> & {detail?: unknown}): ObsEvent | undefined {
    const event = schema.parse({ts:e.ts,stage:e.stage,status:e.status,duration_ms:e.duration_ms,detail:e.detail ?? {}});
    const line = JSON.stringify(event, (_key,value) => value instanceof Error ? value.message : value) + '\n';
    if (Buffer.byteLength(line) > IMAGE_EVENT_BYTES) return;
    const file = path.join(this.dir,filename);
    let prior = '';
    try {
      const st = lstatSync(file);
      if (!st.isFile() || st.isSymbolicLink() || st.size > IMAGE_EVENT_BYTES) return;
      prior = readFileSync(file,'utf8');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (Buffer.byteLength(prior)+Buffer.byteLength(line) > IMAGE_EVENT_BYTES || prior.split('\n').length-1 >= IMAGE_EVENT_LINES) return;
    const fd = openSync(file, constants.O_WRONLY|constants.O_CREAT|constants.O_APPEND|constants.O_NOFOLLOW, 0o600);
    try { if (fstatSync(fd).isFile()) appendFileSync(fd,line,'utf8'); } finally { closeSync(fd); }
    return {...e,id:0,detail_json:JSON.stringify(event.detail)};
  }
}

/** 领取后有界读取，逐行校验，再由主进程秘密注册表脱敏入库；拒绝伪造票据与阶段。 */
export async function ingestImageEvents(dir: string, observer: Trace = trace): Promise<void> {
  const file = path.join(dir, filename), claimed = file+'.'+randomUUID()+'.draining';
  try {
    const st = await fs.lstat(dir);
    if (!st.isDirectory() || st.isSymbolicLink() || await fs.realpath(dir) !== path.resolve(dir)) return;
    await fs.rename(file,claimed);
  } catch { return; }
  try {
    const st = await fs.lstat(claimed);
    if (!st.isFile() || st.isSymbolicLink() || st.size > IMAGE_EVENT_BYTES) return;
    const handle = await fs.open(claimed, constants.O_RDONLY|constants.O_NOFOLLOW);
    let raw: string;
    try {
      const bytes=Buffer.alloc(IMAGE_EVENT_BYTES+1);
      const {bytesRead}=await handle.read(bytes,0,bytes.length,0);
      if (bytesRead > IMAGE_EVENT_BYTES) return;
      raw=bytes.subarray(0,bytesRead).toString('utf8');
    } finally { await handle.close(); }
    for (const line of raw.split('\n').slice(0,IMAGE_EVENT_LINES)) {
      try {
        const e=schema.parse(JSON.parse(line));
        observer.event(path.basename(dir),e.stage,{ts:e.ts,status:e.status,durationMs:e.duration_ms ?? undefined,detail:e.detail});
      } catch { /* 损坏或非白名单行忽略 */ }
    }
  } catch { /* 观测故障不影响图片收取 */ }
  finally { await fs.unlink(claimed).catch(()=>undefined); }
}
