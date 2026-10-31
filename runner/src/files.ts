import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { FILE_MAX_BYTES, SOURCE_MAX_BYTES, relativePath, ephemeralPath, validateSnapshot, type Snapshot } from "./protocol.ts";
export const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
export function inside(root: string, relative: string): string {
  const target = path.resolve(root, relativePath(relative)), base = path.resolve(root);
  if (!target.startsWith(base + path.sep)) throw new Error("path_denied");
  return target;
}
export async function atomicJson(target: string, value: unknown) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temp = target + ".tmp";
  await fs.writeFile(temp, JSON.stringify(value), { encoding: "utf8", mode: 0o600 });
  await fs.rename(temp, target);
}
export async function readJson(target: string, limit = 8 * 1024 * 1024): Promise<unknown> {
  const stat = await fs.lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw new Error("invalid_file");
  return JSON.parse(await fs.readFile(target, "utf8"));
}
export async function exists(target: string) { try { await fs.lstat(target); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; } }
/** 只在 guest 已停止后读取其输出。拒绝链接、reparse/junction 和越界路径。 */
export async function plainFile(root: string, relative: string, limit = FILE_MAX_BYTES): Promise<Buffer> {
  const target = inside(root, relative), parts = relativePath(relative).split("/");
  for (let i = 1; i <= parts.length; i++) {
    const name = path.join(root, ...parts.slice(0, i)), stat = await fs.lstat(name);
    if (stat.isSymbolicLink() || i < parts.length && !stat.isDirectory() || i === parts.length && !stat.isFile()) throw new Error("path_denied");
    if (i === parts.length && stat.size > limit) throw new Error("too_large");
  }
  if (path.resolve(await fs.realpath(target)) !== path.resolve(target)) throw new Error("path_denied");
  return fs.readFile(target);
}
export async function snapshot(root: string, outputObjects: string): Promise<Snapshot> {
  const files: Snapshot["files"] = [], directories: string[] = []; let totalBytes = 0;
  await fs.mkdir(outputObjects, { recursive: true });
  async function walk(relative: string) {
    for (const entry of await fs.readdir(relative ? inside(root, relative) : root, { withFileTypes: true })) {
      const name = relative ? relative + "/" + entry.name : entry.name;
      if (ephemeralPath(name)) continue;
      relativePath(name);
      if (entry.isSymbolicLink()) throw new Error("path_denied");
      if (entry.isDirectory()) { directories.push(name); if (directories.length > 20000) throw new Error("workspace_quota"); await walk(name); }
      else if (entry.isFile()) {
        const bytes = await plainFile(root, name), sha = sha256(bytes);
        totalBytes += bytes.length; if (totalBytes > SOURCE_MAX_BYTES || files.length >= 20000) throw new Error("workspace_quota");
        await fs.writeFile(path.join(outputObjects, sha), bytes);
        files.push({ path: name, sha256: sha, bytes: bytes.length, mime: "application/octet-stream", mode: 420 });
      } else throw new Error("path_denied");
    }
  }
  await walk(""); return validateSnapshot({ files, directories, totalBytes });
}
export async function restore(root: string, source: Snapshot, objects: string) {
  validateSnapshot(source); await fs.mkdir(root, { recursive: true });
  for (const dir of source.directories) await fs.mkdir(inside(root, dir), { recursive: true });
  for (const file of source.files) {
    const bytes = await plainFile(objects, file.sha256);
    if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256) throw new Error("blob_corrupt");
    const target = inside(root, file.path);
    await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, bytes);
  }
}
export async function removeInside(root: string, target: string) {
  const base = path.resolve(root), resolved = path.resolve(target);
  if (!resolved.startsWith(base + path.sep)) throw new Error("path_denied");
  const stat = await fs.lstat(resolved).catch((e: NodeJS.ErrnoException) => { if (e.code !== "ENOENT") throw e; });
  if (stat) await fs.rm(resolved, { recursive: stat.isDirectory() && !stat.isSymbolicLink(), force: true });
}
