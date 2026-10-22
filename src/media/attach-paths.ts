import { promises as fs } from "node:fs";
import path from "node:path";

/** 按会话线程键命名的图片与文件目录（docs/ARCHITECTURE.md §8.2），供 codex、pi 和发送共用。 */
export function attachmentDirs(dataDir: string, key: string) {
  const segment = key.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(segment)) throw new Error("非法附件目录键");
  return { attachDir: path.join(dataDir, "images", segment), fileDir: path.join(dataDir, "files", segment) };
}
