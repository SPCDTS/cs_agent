import { promises as fs } from "node:fs";
import path from "node:path";

/** 按会话线程键命名的图片与文件目录（docs/ARCHITECTURE.md §8.2），供 codex、pi 和发送共用。 */
export function attachmentDirs(dataDir: string, key: string) {
  const segment = key.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(segment)) throw new Error("非法附件目录键");
  return { attachDir: path.join(dataDir, "images", segment), fileDir: path.join(dataDir, "files", segment) };
}

export function validateAttachmentPath(value: string, variable: string): void {
  const safe = /^\/[A-Za-z0-9._/-]+$/.test(value) ||
    (process.platform === "win32" && /^[A-Za-z]:[\\/][A-Za-z0-9._\\/-]*$/.test(value));
  if (!safe || !path.isAbsolute(value) || value.split(/[\\/]/).includes("..")) throw new Error(`非法的 ${variable}：必须为安全字符组成且不含 .. 的绝对路径`);
}

/** 先检查父目录再创建子目录，拒绝软链接和 realpath 越界。 */
export async function resolveAttachmentDir(raw: string | undefined, root: string, variable: string): Promise<string> {
  if (!raw) throw new Error(`${variable} 未设置`);
  validateAttachmentPath(raw, variable);
  const base = path.resolve(root), dir = path.resolve(raw), rel = path.relative(base, dir);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(rel)) throw new Error(`${variable} 必须是指定根目录的直接子目录`);
  const ensure = async (target: string) => {
    // 对已有祖先逐层检查，mkdir 不会经由链接写到根目录外。
    const missing: string[] = [];
    for (let p = target; ; p = path.dirname(p)) {
      const st = await fs.lstat(p).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
      if (st) {
        if (!st.isDirectory() || st.isSymbolicLink() || path.relative(path.resolve(p), await fs.realpath(p))) throw new Error(`${variable} 目录不可为链接或越界`);
        break;
      }
      missing.unshift(p);
    }
    for (const p of missing) await fs.mkdir(p).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
    const st = await fs.lstat(target);
    if (!st.isDirectory() || st.isSymbolicLink() || path.relative(target, await fs.realpath(target))) throw new Error(`${variable} 目录不可为链接或越界`);
  };
  await ensure(base);
  await ensure(dir);
  if (path.relative(await fs.realpath(base), await fs.realpath(dir)) !== rel) throw new Error(`${variable} 目录越界`);
  return fs.realpath(dir);
}
