import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { validateImageHeader } from "../header.js";

const IMAGE_FILE_MANIFEST = "image-files.json";
const filename = z.string().min(1).max(255).refine(s => !/[\\/:]/.test(s) && s !== "." && s !== "..");
const schema = z.array(z.object({ filename, downloaded: z.boolean() }).strict()).max(4);
export type ImageFileManifest = z.infer<typeof schema>;

export async function atomicJson(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(value), { encoding: "utf8", flag: "wx" });
    await fs.rename(tmp, file);
  } finally { await fs.unlink(tmp).catch(() => undefined); }
}

export async function validImageFile(file: string): Promise<boolean> {
  try {
    const st = await fs.lstat(file);
    if (!st.isFile() || st.size > 10 * 1024 * 1024) return false;
    validateImageHeader(await fs.readFile(file));
    return true;
  } catch { return false; }
}

export async function readImageFiles(dir: string): Promise<ImageFileManifest | undefined> {
  const file = path.join(dir, IMAGE_FILE_MANIFEST);
  const st = await fs.lstat(file).catch((err: NodeJS.ErrnoException) => { if (err.code !== "ENOENT") throw err; });
  if (!st) return undefined;
  if (!st.isFile() || st.size > 4096) throw new Error("非法图片文件清单");
  return schema.parse(JSON.parse(await fs.readFile(file, "utf8")));
}

/** 全部预期文件先落盘；即使最后一次 rename 后崩溃，也以实际文件校验补全 downloaded。 */
export async function prepareImageFiles(dir: string, names: string[]): Promise<ImageFileManifest> {
  const files = schema.parse(names.map(name => ({ filename: name, downloaded: false })));
  if (new Set(names).size !== names.length) throw new Error("图片输出文件名重复");
  await fs.mkdir(dir, { recursive: true });
  for (const file of files) file.downloaded = await validImageFile(path.join(dir, file.filename));
  await atomicJson(path.join(dir, IMAGE_FILE_MANIFEST), files);
  return files;
}

export async function saveImageFile(dir: string, files: ImageFileManifest, index: number, bytes: Uint8Array): Promise<void> {
  const item = files[index]!;
  validateImageHeader(Buffer.from(bytes));
  const dest = path.join(dir, item.filename);
  const tmp = `${dest}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, bytes, { flag: "wx" });
    await fs.rename(tmp, dest);
  } finally { await fs.unlink(tmp).catch(() => undefined); }
  item.downloaded = true;
  await atomicJson(path.join(dir, IMAGE_FILE_MANIFEST), files);
}
