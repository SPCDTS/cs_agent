/**
 * 回复附件图片校验：0–4 张，单张 12 B–10 MiB，合计 ≤ 20 MiB，
 * realpath 必须落在 imageRoot 下，魔数仅允许 PNG / JPEG / WebP / GIF。
 */
import { closeSync, fstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";

export const MAX_IMAGES = 4;
export const MIN_IMAGE_BYTES = 12;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024;

export interface ImageSegment {
  type: "image";
  data: { file: string };
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function isSupportedImage(data: Buffer): boolean {
  const png = data.subarray(0, 8).equals(PNG_MAGIC);
  const jpeg = data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  const webp = data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP";
  const head = data.toString("ascii", 0, 6);
  const gif = (head === "GIF87a" || head === "GIF89a") && data.length >= 14
    && data.readUInt16LE(6) > 0 && data.readUInt16LE(8) > 0 && data[data.length - 1] === 0x3b;
  return png || jpeg || webp || gif;
}

function resolveInsideRoot(file: string, root: string): string {
  let base: string;
  let resolved: string;
  try {
    base = realpathSync(root);
    resolved = realpathSync(file);
  } catch {
    throw new Error("图片不存在或图片根目录不可用：" + file);
  }
  const rel = relative(base, resolved);
  if (!rel || rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) {
    throw new Error("图片必须位于允许的图片目录内：" + file);
  }
  return resolved;
}

function readBoundedFile(path: string): Buffer {
  const fd = openSync(path, "r");
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size < MIN_IMAGE_BYTES || stat.size > MAX_IMAGE_BYTES) {
      throw new Error("图片必须为 12 B～10 MiB 的普通文件：" + path);
    }
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** 读取并校验单张图片，返回原始字节。 */
export function loadImage(file: string, root: string): Buffer {
  const data = readBoundedFile(resolveInsideRoot(file, root));
  if (!isSupportedImage(data)) throw new Error("仅支持 PNG、JPEG、WebP、GIF 图片：" + file);
  return data;
}

/** 校验一组图片并转为 OneBot base64:// 图片段；空数组返回空数组。 */
export function prepareImages(files: readonly string[], root: string): ImageSegment[] {
  if (!Array.isArray(files) || files.length > MAX_IMAGES) throw new Error("每次最多 4 张图片。");
  if (files.some(f => typeof f !== "string" || !f)) throw new Error("图片路径无效。");
  const buffers = files.map(file => loadImage(file, root));
  const total = buffers.reduce((sum, b) => sum + b.length, 0);
  if (total > MAX_TOTAL_IMAGE_BYTES) throw new Error("图片合计不能超过 20 MiB。");
  return buffers.map(b => ({ type: "image", data: { file: "base64://" + b.toString("base64") } }));
}
