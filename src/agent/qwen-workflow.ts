import { randomInt } from "node:crypto";
import { imageDimensions, validateImageOptions, type ImageOptions } from "./image-options.js";

export type ApiWorkflow = Record<string, { class_type: string; inputs: Record<string, unknown> }>;
export type QwenModels = { unet: string; clip: string; vae: string };
export const QWEN_MODELS: QwenModels = {
  unet: "qwen_image_2.1_turbo_int8_convrot.safetensors",
  clip: "qwen3vl_8b_w4a8.safetensors",
  vae: "qwen_image_2.1_vae_bf16.safetensors",
};

/** reference_images 在这里是上传后 ComfyUI input 内的名字，不是本机路径。 */
export function buildQwenWorkflow(input: ImageOptions, config: { filenamePrefix: string; models?: QwenModels; cache?: boolean }): ApiWorkflow {
  const opts = validateImageOptions(input);
  if (!/^[A-Za-z0-9_-]+$/.test(config.filenamePrefix)) throw new Error("非法的图片文件名前缀");
  const models = config.models ?? QWEN_MODELS;
  const [width, height] = imageDimensions(opts);
  const edit = !!opts.reference_images?.length;
  const cache = config.cache ?? process.env.COMFY_QWEN_CACHE === "true";
  const graph: ApiWorkflow = {
    "1": { class_type: "UNETLoader", inputs: { unet_name: models.unet, weight_dtype: "default" } },
    "2": { class_type: "CLIPLoader", inputs: { clip_name: models.clip, type: "qwen_image", device: "default" } },
    "3": { class_type: "VAELoader", inputs: { vae_name: models.vae } },
    "4": { class_type: "TextEncodeQwenImage21", inputs: { clip: ["2", 0], prompt: opts.transparent ? opts.prompt + "\n透明背景，输出带 alpha 通道的 PNG。" : opts.prompt,
      negative_prompt: opts.negative_prompt ?? "", resolution: Math.round(Math.sqrt(width * height) / 32) * 32,
      ...(edit ? { vae: ["3", 0] } : {}) } },
    "6": { class_type: "KSampler", inputs: { model: [cache ? "10" : "1", 0], positive: ["4", 0], negative: ["4", 1],
      latent_image: edit ? ["4", 2] : ["5", 0], seed: opts.seed ?? randomInt(2 ** 48 - 1),
      steps: 8, cfg: 1, sampler_name: "euler", scheduler: "simple", denoise: 1 } },
    "7": { class_type: "VAEDecode", inputs: { samples: ["6", 0], vae: ["3", 0] } },
    "8": { class_type: "SaveImage", inputs: { images: ["7", 0], filename_prefix: config.filenamePrefix } },
  };
  if (!edit) graph["5"] = { class_type: "EmptyLatentImage", inputs: { width, height, batch_size: opts.count ?? 1 } };
  if (edit && (opts.count ?? 1) > 1) {
    graph["5"] = { class_type: "RepeatLatentBatch", inputs: { samples: ["4", 2], amount: opts.count } };
    graph["6"]!.inputs.latent_image = ["5", 0];
  }
  for (const [i, image] of (opts.reference_images ?? []).entries()) {
    const id = String(20 + i);
    graph[id] = { class_type: "LoadImage", inputs: { image } };
    graph["4"]!.inputs[`images.image_${i + 1}`] = [id, 0];
  }
  if (cache) graph["10"] = { class_type: "QwenImage21Cache", inputs: { model: ["1", 0], device: "auto", dtype: "default" } };
  // 2.1 原生 RGBA VAE；官方 background_removal 的 VAEDecode → SaveImageAdvanced。
  // layered 的 5D/16 通道 latent 与 2.1 的 4D/64 通道不兼容。
  if (opts.transparent) graph['8'] = { class_type: 'SaveImageAdvanced', inputs: {
    images: ['7', 0], filename_prefix: config.filenamePrefix, format: 'png',
    'format.bit_depth': '8-bit', 'format.input_color_space': 'sRGB',
  } };
  return graph;
}
