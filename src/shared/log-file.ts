import { promises as fs } from "node:fs";
import path from "node:path";
import type { LogLine } from "./log-core.js";

const missing = (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT";

/** 仅接收日志出口已经脱敏的对象；串行追加与轮转，文件系统故障不能反向打日志。 */
export function createLogFileSink(file: string, maxBytes = 10 * 1024 * 1024) {
  let pending = Promise.resolve(), closed = false;
  let size: number | undefined;
  return {
    write(line: LogLine): void {
      if (closed) return;
      try {
        const text = JSON.stringify(line, (_key, value) => value instanceof Error ? value.message : value) + "\n";
        const bytes = Buffer.byteLength(text);
        pending = pending.then(async () => {
          if (size === undefined) {
            await fs.mkdir(path.dirname(file), { recursive: true });
            size = await fs.stat(file).then(stat => stat.size, error => { if (missing(error)) return 0; throw error; });
          }
          if (size > 0 && size + bytes > maxBytes) {
            await fs.rm(file + ".3", { force: true });
            for (let i = 2; i >= 0; i--) {
              await fs.rename(i ? `${file}.${i}` : file, `${file}.${i + 1}`).catch(error => { if (!missing(error)) throw error; });
            }
            size = 0;
          }
          await fs.appendFile(file, text, "utf8");
          size += bytes;
        }).catch(() => { size = undefined; });
      } catch { /* 序列化失败也不能阻断调用方 */ }
    },
    async close(): Promise<void> { closed = true; await pending; },
  };
}
