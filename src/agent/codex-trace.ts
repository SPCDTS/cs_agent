import { promises as fs } from "node:fs";
import path from "node:path";

const DAY_MS = 86_400_000;

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** 只清理官方 trace 根目录内超期的普通文件；不跟随符号链接，也不删除目录。0 表示禁用。 */
export async function purgeCodexTrace(codexHome: string, retentionDays: number, now = Date.now()): Promise<number> {
  if (!Number.isSafeInteger(retentionDays) || retentionDays < 0 || !Number.isFinite(now)) throw new Error("非法的 Codex trace 保留期");
  if (retentionDays === 0) return 0;
  const root = path.resolve(codexHome, "trace");
  const rootInfo = await fs.lstat(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) return 0;
  const realRoot = await fs.realpath(root);
  const cutoff = now - retentionDays * DAY_MS;
  let removed = 0;

  async function visit(directory: string): Promise<void> {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.resolve(directory, entry.name);
      if (!inside(root, file)) continue;
      try {
        // lstat 不跟随链接；realpath 二次限定根目录，防止目录被换成外部链接。
        const info = await fs.lstat(file);
        if (info.isSymbolicLink() || !inside(realRoot, await fs.realpath(file))) continue;
        if (info.isDirectory()) await visit(file);
        else if (info.isFile() && info.mtimeMs < cutoff) {
          await fs.unlink(file);
          removed++;
        }
      } catch (error) {
        // Codex 或其他清理过程可能已经移走文件。
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }

  await visit(root);
  return removed;
}
