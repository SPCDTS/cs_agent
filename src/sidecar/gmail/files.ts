import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { GmailError } from "./errors.js";

export async function readJson(file: string): Promise<unknown> {
  return JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/u, ""));
}

export function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export async function atomicJson(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, file);
  } catch {
    throw new GmailError("storage", "Gmail 状态文件写入失败，请检查目录权限");
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}
