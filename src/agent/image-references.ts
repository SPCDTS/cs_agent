import { promises as fs } from "node:fs";
import path from "node:path";
import type { Access } from "../context/access.js";
import type { ContextStore } from "../context/store.js";
import { readMediaFile } from "../context/media.js";
import { loadImage } from "../qq/image.js";

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

/** 票据附件与本次访问范围内的媒体库取并集；媒体权限先于文件读取。 */
export async function validateReferencesWithMedia(
  refs: readonly string[], allowed: readonly string[], incomingDir: string,
  media: { dataDir: string; access: Access | undefined; openStore: () => ContextStore },
): Promise<string[]> {
  if (refs.length > 3) throw new Error("参考图最多 3 张");
  const permitted = new Set(allowed.map(p => path.resolve(p)));
  const output: string[] = [];
  for (const file of refs) {
    if (!path.isAbsolute(file) || file.split(/[\\/]/).includes("..")) throw new Error("参考图路径非法");
    if (permitted.has(path.resolve(file))) {
      output.push(...await validateReferences([file], allowed, incomingDir));
      continue;
    }
    const canonical = path.resolve(file);
    if (!media.access || !media.openStore().mediaPathAllowed(media.access, canonical))
      throw new Error("参考图不在当前会话媒体范围内");
    await readMediaFile(media.dataDir, canonical);
    output.push(canonical);
  }
  return output;
}
