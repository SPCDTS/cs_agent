import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/** 写入并删除探针文件，确认目录可写；可写返回 null，否则返回错误码/消息。 */
export async function probeWritable(dir: string): Promise<string | null> {
  try {
    await fs.mkdir(dir, { recursive: true });
    const probe = path.join(dir, `.write-probe-${process.pid}-${Date.now()}`);
    await fs.writeFile(probe, "");
    await fs.unlink(probe);
    return null;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    return e.code ?? e.message;
  }
}

/** 当前进程身份描述，例如 "uid 1000 (node)"；Windows 无 uid 时只给用户名。 */
export function processIdentity(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  let user = "?";
  try {
    user = os.userInfo().username;
  } catch {
    /* 容器内 uid 可能没有 passwd 条目 */
  }
  return uid === undefined ? user : `uid ${uid} (${user})`;
}

/** 检查一组目录是否可写，返回不可写的目录及原因。 */
export async function findUnwritable(dirs: string[]): Promise<{ dir: string; reason: string }[]> {
  const out: { dir: string; reason: string }[] = [];
  for (const dir of dirs) {
    const reason = await probeWritable(dir);
    if (reason) out.push({ dir, reason });
  }
  return out;
}
