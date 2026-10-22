import { promises as fs } from "node:fs";
import path from "node:path";
import { loadImage } from "./limits.js";

/** 入站参考图的范围校验：字面允许列表 + realpath 防止符号链接逃逸。 */
export async function validateReferences(refs: readonly string[], allowed: readonly string[], incomingDir: string): Promise<string[]> {
  if (refs.length > 3) throw new Error("参考图最多 3 张");
  if (!refs.length) return [];
  const root = await fs.realpath(incomingDir);
  const parent = await fs.realpath(path.dirname(incomingDir));
  if (path.dirname(root) !== parent || path.basename(root) !== path.basename(incomingDir)) throw new Error("参考图目录越界");
  const permitted = new Set(allowed.map(p => path.resolve(p)));
  const output: string[] = [];
  for (const file of refs) {
    if (!path.isAbsolute(file) || file.split(/[\\/]/).includes("..") || !permitted.has(path.resolve(file))) throw new Error("参考图不在本条输入的允许列表内");
    loadImage(file, root);
    output.push(await fs.realpath(file));
  }
  return output;
}
