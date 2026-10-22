import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { imageOptionsSchema } from "./image-options.js";
import { atomicJson } from "./image-files.js";

export const PENDING_IMAGE_JOBS = "pending-jobs.json";
const pendingJobSchema = z.object({
  prompt_id: z.string().min(1).max(256).optional(), backend: z.string().min(1).max(64),
  filenamePrefix: z.string().max(128).regex(/^[A-Za-z0-9_-]+$/),
  options: imageOptionsSchema.extend({ reference_images: z.array(z.string().min(1).max(1024)).max(3).optional() }),
  callDir: z.string().min(1).max(1024), submittedAt: z.number().finite().nonnegative(),
  status: z.enum(["intent", "submitted", "done"]).optional(),
  remoteTerminal: z.boolean().optional(),
}).strict();
const jobsSchema = z.array(pendingJobSchema).max(8).refine(jobs => new Set(jobs.map(j => j.filenamePrefix)).size === jobs.length);
export type PendingImageJob = z.infer<typeof pendingJobSchema>;
export class PendingImageMarkerError extends Error {}

export async function readPendingImages(dir: string): Promise<PendingImageJob[]> {
  const file = path.join(dir, PENDING_IMAGE_JOBS);
  try {
    const st = await fs.lstat(file);
    if (!st.isFile() || st.size > 65536) throw new Error("非法清单文件");
    const handle = await fs.open(file, "r");
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.ino !== st.ino || opened.dev !== st.dev || opened.size > 65536) throw new Error("清单已替换");
      const bytes = Buffer.alloc(65537);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead > 65536) throw new Error("清单过大");
      return jobsSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytesRead))));
    } finally { await handle.close(); }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new PendingImageMarkerError("附件任务清单无效");
  }
}

export async function quarantinePendingImages(dir: string): Promise<void> {
  const file = path.join(dir, PENDING_IMAGE_JOBS);
  await fs.rename(file, file + ".bad-" + Date.now());
}

/** 清单锁的过期时间：持锁进程崩溃后留下的锁文件超过它即视为失效 */
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 15_000;

/**
 * 清单的读改写在锁内进行：image_gen MCP 进程追加任务与主进程补收后移除共用同一把锁（<清单>.lock，独占创建），
 * 互不覆盖对方的改动。锁文件过期（持锁进程崩溃）则清掉重试。
 */
async function withPendingLock<T>(dir: string, work: () => Promise<T>): Promise<T> {
  const lock = path.join(dir, PENDING_IMAGE_JOBS + ".lock");
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      await (await fs.open(lock, "wx")).close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const st = await fs.stat(lock).catch(() => undefined);
      if (st && Date.now() - st.mtimeMs > LOCK_STALE_MS) { await fs.rm(lock, { force: true }); continue; }
      if (Date.now() >= deadline) throw new Error("附件任务清单正被占用");
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  try { return await work(); }
  finally { await fs.rm(lock, { force: true }); }
}

/** 意图与 prompt_id 都原子更新，不等超时才记账；与补收的移除共用清单锁。 */
export async function savePendingImage(dir: string, job: PendingImageJob): Promise<void> {
  await withPendingLock(dir, async () => {
    const jobs = await readPendingImages(dir);
    const index = jobs.findIndex(j => j.filenamePrefix === job.filenamePrefix);
    if (index < 0) jobs.push(job); else jobs[index] = job;
    const validated = jobsSchema.parse(jobs);
    if (Buffer.byteLength(JSON.stringify(validated), "utf8") > 65536) throw new Error("附件任务清单过大");
    await atomicJson(path.join(dir, PENDING_IMAGE_JOBS), validated);
  });
}

/** 移除已处理的任务（按 filenamePrefix），保留期间新追加的；清单空了就删除文件。与追加共用清单锁。 */
export async function removePendingImages(dir: string, prefixes: ReadonlySet<string>): Promise<void> {
  await withPendingLock(dir, async () => {
    const file = path.join(dir, PENDING_IMAGE_JOBS);
    const rest = (await readPendingImages(dir)).filter(job => !prefixes.has(job.filenamePrefix));
    if (rest.length) await atomicJson(file, jobsSchema.parse(rest));
    else await fs.rm(file, { force: true });
  });
}

/** 收取只允许写入当前票据的 call-N 目录，恢复时再次检查软链接。 */
export async function pendingCallDir(dir: string, callDir: string): Promise<string> {
  const root = await fs.realpath(dir);
  const rel = path.relative(root, path.resolve(callDir));
  if (!/^call-\d+$/.test(rel)) throw new Error("非法的延迟收图目录");
  const real = await fs.realpath(callDir);
  if (path.relative(root, real) !== rel) throw new Error("延迟收图目录越界");
  return real;
}
