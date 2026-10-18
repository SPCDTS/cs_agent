import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";

export const THREAD_ARCHIVE_LIMIT = 200;

/** 读取 JSONL 用于迁移或轮换；不存在视为空，其他错误不能静默丢失归档。 */
export async function readThreadArchive<T>(file: string): Promise<T[]> {
  try {
    return (await fs.readFile(file, "utf8")).split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line) as T);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

/** 调用方持有归档锁；仅保留最新 200 行，以原子替换避免半截镜像。 */
export async function writeThreadArchive(file: string, rows: readonly unknown[]): Promise<void> {
  const tmp = file + "." + randomUUID() + ".tmp";
  try {
    const lines = rows.slice(-THREAD_ARCHIVE_LIMIT).map(row => JSON.stringify(row));
    await fs.writeFile(tmp, lines.length ? lines.join("\n") + "\n" : "", { encoding: "utf8", flag: "wx", mode: 0o600 });
    await fs.rename(tmp, file);
  } finally { await fs.rm(tmp, { force: true }).catch(() => undefined); }
}
