import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { ASPECTS, SIZES, validateImageOptions, type ImageOptions } from "../image-options.js";
import { referenceUploads, ticketImageDir, type ImageBackend } from "../image-gen.js";
import { validateReferences } from "../image-references.js";
import { collectNewImages } from "../image-collect.js";
import { PiRequestDoc } from "./request.js";

export type PiImageBackend = Pick<ImageBackend, "submit" | "collect" | "clearReferences">;

/** 生图不是安全重放操作：中断后由 pi-durable 返回 interrupted，不盲目再提交。 */
export function imageTool(dataDir: string, backend: PiImageBackend) {
  return defineTool({
    name: "generate_image", description: "按描述生成或编辑图片，自动随本次 QQ 回复发送；参考图只能选本轮提供的文件。",
    replay: "unsafe",
    parameters: Type.Object({
      prompt: Type.String({ minLength: 1, maxLength: 2000 }),
      negative_prompt: Type.Optional(Type.String({ maxLength: 2000 })),
      aspect: Type.Optional(Type.Union(ASPECTS.map(a => Type.Literal(a)))),
      size: Type.Optional(Type.Union(SIZES.map(s => Type.Literal(s)))),
      count: Type.Optional(Type.Integer({ minimum: 1, maximum: 4 })),
      seed: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
      reference_images: Type.Optional(Type.Array(Type.String(), { maxItems: 3 })),
      transparent: Type.Optional(Type.Boolean()),
    }, { additionalProperties: false }),
    async execute(args, api, context) {
      const request = await api.snapshot(PiRequestDoc, api.conversationId, context);
      const call = request?.calls[String(api.taskId)];
      if (!request?.ticket || !call || call.kind !== "generate_image") throw new Error("生图请求未绑定");
      const signal = AbortSignal.any([AbortSignal.timeout(Math.max(1, request.deadline - Date.now())), ...(context.abortSignal ? [context.abortSignal] : [])]);
      signal.throwIfAborted();
      const opts: ImageOptions = validateImageOptions(args);
      if (opts.reference_images?.some(file => !request.images.includes(file))) throw new Error("参考图只能选择本票据提供的文件");
      opts.reference_images = await validateReferences(opts.reference_images ?? [], request.images,
        path.join(dataDir, "incoming", request.ticket));
      const root = path.resolve(dataDir, "images");
      await fs.mkdir(root, { recursive: true });
      if (await fs.realpath(root) !== path.join(await fs.realpath(dataDir), "images")) throw new Error("图片根目录不能是符号链接");
      const ticketDir = ticketImageDir(root, request.ticket);
      await fs.mkdir(ticketDir, { recursive: true });
      if (await fs.realpath(ticketDir) !== ticketDir) throw new Error("票据图片目录不能是符号链接");
      const dir = path.join(ticketDir, `call-${call.ordinal}`);
      // 已存在的目录不覆盖：保留上次未完成调用的输出供适配器收集。
      await fs.mkdir(dir);
      const subfolder = `pi-${createHash("sha256").update(request.ticket).digest("hex").slice(0, 24)}-${call.ordinal}`;
      const uploads = referenceUploads(opts, subfolder);
      const manifest = path.join(dir, "remote-uploads.json");
      if (uploads.length && !backend.clearReferences) throw new Error("生图后端不支持参考图清理");
      if (uploads.length) await fs.writeFile(manifest, JSON.stringify(uploads), { encoding: "utf8", flag: "wx" });
      try {
        const id = await backend.submit(opts, { filenamePrefix: subfolder, referenceSubfolder: subfolder, count: opts.count ?? 1, imageOptions: opts }, signal);
        await backend.collect(id, dir, signal, opts);
        const images = await collectNewImages(dir, new Set());
        if (!images.length) throw new Error("未生成有效图片");
        return { output: [{ type: "text" as const, text: `已生成 ${images.length} 张图片，将自动附带。` }] };
      } finally {
        if (uploads.length) { await backend.clearReferences!(uploads); await fs.unlink(manifest); }
      }
    },
  });
}
