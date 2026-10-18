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

/** 单票据工具串行执行；意图与 prompt_id 都原子更新，不等超时才记账。 */
export async function savePendingImage(dir: string, job: PendingImageJob): Promise<void> {
  const jobs = await readPendingImages(dir);
  const index = jobs.findIndex(j => j.filenamePrefix === job.filenamePrefix);
  if (index < 0) jobs.push(job); else jobs[index] = job;
  const validated = jobsSchema.parse(jobs);
  if (Buffer.byteLength(JSON.stringify(validated), "utf8") > 65536) throw new Error("附件任务清单过大");
  await atomicJson(path.join(dir, PENDING_IMAGE_JOBS), validated);
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
