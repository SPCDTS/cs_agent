import { promises as fs } from "node:fs";
import path from "node:path";
import { loadImage } from "../limits.js";

/** 注入 TOML 的清单只接受绝对路径，不允许引号、逗号、控制字符或遍历段。 */
export function imageRefsValue(refs: readonly string[]): string {
  if (refs.length > 3) throw new Error("IMAGE_REFS 最多 3 张");
  return refs.map(file => {
    if (!path.isAbsolute(file) || !/^[A-Za-z0-9._:/\\-]+$/.test(file) || file.split(/[\\/]/).includes("..")) {
      throw new Error("非法的 IMAGE_REFS 路径");
    }
    return file.replace(/\\/g, "/");
  }).join(",");
}

/** 三个入口共用的票据范围校验：字面允许列表 + realpath 防止符号链接逃逸。 */
export async function validateReferences(refs: readonly string[], allowed: readonly string[], incomingDir: string): Promise<string[]> {
  if (refs.length > 3) throw new Error("参考图最多 3 张");
  if (!refs.length) return [];
  const root = await fs.realpath(incomingDir);
  const parent = await fs.realpath(path.dirname(incomingDir));
  if (path.dirname(root) !== parent || path.basename(root) !== path.basename(incomingDir)) throw new Error("参考图目录越界");
  const permitted = new Set(allowed.map(p => path.resolve(p)));
  const output: string[] = [];
  for (const file of refs) {
    if (!path.isAbsolute(file) || file.split(/[\\/]/).includes("..") || !permitted.has(path.resolve(file))) throw new Error("参考图不在本票据 IMAGE_REFS 允许列表内");
    loadImage(file, root);
    output.push(await fs.realpath(file));
  }
  return output;
}
