import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
export const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
export async function atomicJson(target: string, value: unknown) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temp = target + "." + randomUUID() + ".tmp";
  await fs.writeFile(temp, JSON.stringify(value), { encoding: "utf8", mode: 0o600 });
  try { await fs.rename(temp, target); } finally { await fs.rm(temp, { force: true }); }
}
export async function readJson(target: string, limit = 8 * 1024 * 1024): Promise<unknown> {
  const stat = await fs.lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw new Error("invalid_file");
  return JSON.parse(await fs.readFile(target, "utf8"));
}
export async function exists(target: string) {
  try { await fs.lstat(target); return true; } catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return false; throw error; }
}
