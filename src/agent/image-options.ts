import { z } from "zod";

export const ASPECTS = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"] as const;
export const SIZES = ["1mp", "2mp", "2k"] as const;
export const imageOptionsSchema = z.object({
  prompt: z.string().max(2000).refine(v => v.trim().length > 0, "prompt 不能为空"),
  negative_prompt: z.string().max(2000).optional(),
  aspect: z.enum(ASPECTS).optional(),
  size: z.enum(SIZES).optional(),
  count: z.number().int().min(1).max(4).optional(),
  seed: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  reference_images: z.array(z.string().min(1)).max(3).optional(),
  transparent: z.boolean().optional(),
}).strict();
export type ImageOptions = z.infer<typeof imageOptionsSchema>;
export const IMAGE_OPTIONS_JSON_SCHEMA = z.toJSONSchema(imageOptionsSchema);
export const validateImageOptions = (value: unknown): ImageOptions => imageOptionsSchema.parse(value);

type Dimensions = readonly [number, number];
type Presets = Record<NonNullable<ImageOptions["aspect"]>, Dimensions>;
const ONE_MP: Presets = {
  "1:1": [1024, 1024], "16:9": [1344, 768], "9:16": [768, 1344],
  "4:3": [1152, 864], "3:4": [864, 1152], "3:2": [1216, 832], "2:3": [832, 1216],
};
export const SIZE_PRESETS: Record<NonNullable<ImageOptions["size"]>, Presets> = {
  "1mp": ONE_MP,
  "2mp": Object.fromEntries(Object.entries(ONE_MP).map(([a, dims]) =>
    [a, dims.map(n => Math.round(n * Math.SQRT2 / 32) * 32)])) as unknown as Presets,
  "2k": { "1:1": [2048, 2048], "16:9": [2752, 1536], "9:16": [1536, 2752],
    "4:3": [2368, 1792], "3:4": [1792, 2368], "3:2": [2528, 1696], "2:3": [1696, 2528] },
};
export const imageDimensions = (opts: ImageOptions): Dimensions => SIZE_PRESETS[opts.size ?? "1mp"][opts.aspect ?? "1:1"];
/** 与票据一起保存参数，重启后仍能按相同像素预算计算收取超时。 */
export function imageTimeoutMs(opts: ImageOptions, cap: number): number {
  const base = { "1mp": 120_000, "2mp": 240_000, "2k": 600_000 };
  return Math.min(cap, base[opts.size ?? "1mp"] * (opts.count ?? 1));
}
