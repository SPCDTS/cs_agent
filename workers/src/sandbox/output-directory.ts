import type { DirEntry } from "./client";

export const OUTPUT_ROOT = "/work/.codemode";
export const OUTPUT_RETENTION_MS = 7 * 86400000;
/** 只清理命名符合本模块格式、已过期的输出目录；底层操作仍通过工作区事务提交。 */
export async function createOutputDirectory(files: {
  list(path: string): Promise<DirEntry[]>; mkdir(path: string): Promise<void>; remove(path: string): Promise<void>;
}, prefix = "output-", now = Date.now()): Promise<string> {
  if (!/^[a-zA-Z0-9_-]{0,64}$/.test(prefix)) throw new Error("invalid_request");
  let entries: DirEntry[];
  try { entries = await files.list(OUTPUT_ROOT); }
  catch (error) { if (!(error instanceof Error && error.message === "not_found")) throw error; entries = []; }
  const expired = entries.filter(entry => {
    const stamp = /^(\d{13})-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}-[a-zA-Z0-9_-]{0,64}$/.exec(entry.name)?.[1];
    return entry.type === "dir" && stamp !== undefined && Number(stamp) < now - OUTPUT_RETENTION_MS;
  }).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 10);
  for (const entry of expired) {
    try { await files.remove(`${OUTPUT_ROOT}/${entry.name}`); }
    catch (error) { if (!(error instanceof Error && error.message === "not_found")) throw error; }
  }
  const path = `${OUTPUT_ROOT}/${now}-${crypto.randomUUID()}-${prefix}`;
  await files.mkdir(path);
  return path;
}
