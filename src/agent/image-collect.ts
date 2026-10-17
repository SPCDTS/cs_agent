/**
 * 回合内生成图片的收集（设计 §4.3"图片附带"）：回合开始前记下票据图片目录里已有的文件，
 * 回合结束后取新出现的普通文件（不跟随软链接），按 QQBridge 同一口径校验大小与魔数，按修改时间取前 4 张。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { isSupportedImage, MAX_IMAGE_BYTES, MAX_IMAGES, MIN_IMAGE_BYTES } from "../qq/image.js";
import { log } from "../log.js";

/** 目录内全部文件的相对路径（递归，不跟随软链接）；目录不存在时为空。 */
export async function listFiles(dir: string): Promise<Set<string>> {
  const out = new Set<string>();
  const walk = async (rel: string, depth: number) => {
    if (depth > 4) return;
    const ents = await fs.readdir(path.join(dir, rel), { withFileTypes: true }).catch(() => []);
    for (const e of ents) {
      if (e.name === ".download" || e.name.endsWith(".tmp") || e.name.endsWith(".json") || e.name.includes(".bad-")) continue;
      const r = rel ? path.join(rel, e.name) : e.name;
      if (e.isDirectory()) await walk(r, depth + 1);
      else out.add(r);
    }
  };
  await walk("", 0);
  return out;
}

export async function collectNewImages(dir: string, before: ReadonlySet<string>, limit = MAX_IMAGES): Promise<string[]> {
  const found: { file: string; mtime: number }[] = [];
  for (const rel of await listFiles(dir)) {
    if (before.has(rel)) continue;
    const file = path.join(dir, rel);
    try {
      const st = await fs.lstat(file);
      if (!st.isFile() || st.size < MIN_IMAGE_BYTES || st.size > MAX_IMAGE_BYTES) continue;
      if (!isSupportedImage(await fs.readFile(file))) {
        log.warn("collected file is not a supported image, skipped", { file: rel });
        continue;
      }
      found.push({ file: await fs.realpath(file), mtime: st.mtimeMs });
    } catch {
      /* 文件在检查中途消失：跳过 */
    }
  }
  found.sort((a, b) => a.mtime - b.mtime || a.file.localeCompare(b.file));
  return found.slice(0, limit).map((f) => f.file);
}
