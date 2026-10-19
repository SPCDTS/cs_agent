import path from "node:path";
import type { Access } from "./access.js";
import type { ContextStore } from "./store.js";
import { readMediaFile } from "./media.js";
import { validateReferences } from "../media/gen/image-references.js";

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
