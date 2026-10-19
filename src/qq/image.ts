/**
 * 回复附件图片校验：0–4 张，单张 12 B–10 MiB，合计 ≤ 20 MiB，
 * realpath 必须落在 imageRoot 下，魔数仅允许 PNG / JPEG / WebP / GIF。
 */
import { MAX_IMAGES, MAX_TOTAL_IMAGE_BYTES, loadImage } from "../media/limits.js";
export { MAX_IMAGES, MIN_IMAGE_BYTES, MAX_IMAGE_BYTES, isSupportedImage, loadImage } from "../media/limits.js";

export interface ImageSegment {
  type: "image";
  data: { file: string };
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
