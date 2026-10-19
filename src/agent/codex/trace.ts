import { promises as fs } from "node:fs";
import path from "node:path";

const DAY_MS = 86_400_000;

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** 只清理官方 trace 根目录内的普通文件；先按天，再按 mtime 从旧到新控制总量。
 * 两个限制各以 0 禁用；不跟随符号链接，也不删除目录。bytes 为实际删除的字节数。
 */
export async function purgeCodexTrace(codexHome: string, retentionDays: number, now = Date.now(), maxMb = 512): Promise<{ removed: number; bytes: number }> {
  if (!Number.isSafeInteger(retentionDays) || retentionDays < 0 || !Number.isFinite(now)) throw new Error("非法的 Codex trace 保留期");
  const maxBytes = maxMb * 1024 * 1024;
  if (!Number.isSafeInteger(maxMb) || maxMb < 0 || !Number.isSafeInteger(maxBytes)) throw new Error("非法的 Codex trace 总量上限");
  const result = { removed: 0, bytes: 0 };
  if (retentionDays === 0 && maxMb === 0) return result;
  const root = path.resolve(codexHome, "trace");
  const rootInfo = await fs.lstat(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) return result;
  const realRoot = await fs.realpath(root);
  const cutoff = now - retentionDays * DAY_MS;
  let total = 0;
  const remaining: { file: string; size: number; mtime: number }[] = [];

  async function visit(directory: string): Promise<void> {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.resolve(directory, entry.name);
      if (!inside(root, file)) continue;
      try {
        // lstat 不跟随链接；realpath 二次限定根目录，防止目录被换成外部链接。
        const info = await fs.lstat(file);
        if (info.isSymbolicLink() || !inside(realRoot, await fs.realpath(file))) continue;
        if (info.isDirectory()) await visit(file);
        else if (info.isFile()) {
          if (retentionDays > 0 && info.mtimeMs < cutoff) {
            await fs.unlink(file);
            result.removed++; result.bytes += info.size;
          } else {
            remaining.push({ file, size: info.size, mtime: info.mtimeMs });
            total += info.size;
          }
        }
      } catch (error) {
        // Codex 或其他清理过程可能已经移走文件。
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }

  await visit(root);
  if (maxBytes > 0 && total > maxBytes) {
    remaining.sort((a, b) => a.mtime - b.mtime || a.file.localeCompare(b.file));
    for (const candidate of remaining) {
      if (total <= maxBytes) break;
      try {
        // 扫描后可能发生轮换；删除前再次确认普通文件与根目录边界。
        const info = await fs.lstat(candidate.file);
        if (!info.isFile() || info.isSymbolicLink() || !inside(realRoot, await fs.realpath(candidate.file))) {
          total -= candidate.size; continue;
        }
        await fs.unlink(candidate.file);
        total -= candidate.size;
        result.removed++; result.bytes += info.size;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        total -= candidate.size;
      }
    }
  }
  return result;
}
