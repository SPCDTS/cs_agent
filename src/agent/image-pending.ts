import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { imageOptionsSchema } from "./image-options.js";

export const PENDING_IMAGE_JOBS = "pending-jobs.json";
const pendingJobSchema = z.object({
  prompt_id: z.string().min(1), backend: z.string().min(1),
  filenamePrefix: z.string().regex(/^[A-Za-z0-9_-]+$/),
  options: imageOptionsSchema, callDir: z.string().min(1), submittedAt: z.number().finite(),
});
export type PendingImageJob = z.infer<typeof pendingJobSchema>;

export async function readPendingImages(dir: string): Promise<PendingImageJob[]> {
  const raw = await fs.readFile(path.join(dir, PENDING_IMAGE_JOBS), "utf8").catch(err => {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "[]";
    throw err;
  });
  return z.array(pendingJobSchema).parse(JSON.parse(raw));
}

/** MCP 内调用串行；原子替换清单，避免主进程读到半份 JSON。 */
export async function appendPendingImage(dir: string, job: PendingImageJob): Promise<void> {
  const jobs = await readPendingImages(dir);
  const file = path.join(dir, PENDING_IMAGE_JOBS);
  await fs.writeFile(file + ".tmp", JSON.stringify([...jobs, job]), "utf8");
  await fs.rename(file + ".tmp", file);
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
