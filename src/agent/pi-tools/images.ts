import { observeImages } from "../../media/gen/observed.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { ASPECTS, SIZES, validateImageOptions, type ImageOptions } from "../../media/gen/image-options.js";
import { referenceUploads, type ImageBackend } from "../../media/gen/image-gen.js";
import type { ContextStore } from "../../context/store.js";
import { parseAccess } from "../../context/access.js";
import { validateReferencesWithMedia } from "../../context/image-references.js";
import { collectNewImages } from "../../media/gen/image-collect.js";
import { attachmentDirs } from "../../media/attach-paths.js";
import { UnknownJobError } from "../../media/gen/image-gen.js";
import { readImageFiles, validImageFile } from "../../media/gen/image-files.js";
import { traceKey, type PiCallBinding } from "./request.js";

export type PiImageBackend = Pick<ImageBackend, "name" | "submit" | "collect" | "reconcile" | "clearReferences">;

const within = (root: string, file: string) => path.resolve(file).startsWith(path.resolve(root) + path.sep);

/**
 * 生图在回合内同步完成（没有单轮时限，只受生图收取超时约束）：每次调用一个目录 images/<会话>/call-<调用键摘要>。
 * 不是安全重放操作：中断后由 pi-durable 返回 interrupted，不盲目再提交；崩溃中断的任务不再补收（第 2 阶段取消 late images）。
 */
export function imageTool(dataDir: string, backend: PiImageBackend, binding: (conversationId: number) => Promise<PiCallBinding | undefined>, store: ContextStore) {
  return defineTool({
    name: "generate_image", description: "按描述生成或编辑图片，返回路径后用 send_message 发送；参考图只能选本轮附件或当前会话范围内已召回的图片。",
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
      const bound = await binding(Number(api.conversationId));
      if (!bound) throw new Error("生图请求未绑定");
      const signal = context.abortSignal ?? new AbortController().signal;
      signal.throwIfAborted();
      const opts: ImageOptions = validateImageOptions(args);
      const media = { dataDir, access: parseAccess(bound.access), openStore: () => store };
      const refs: string[] = [];
      for (const file of opts.reference_images ?? []) {
        // 本轮附件按其所在输入的 incoming 目录校验；其余按读取范围走媒体库。
        const key = bound.inputs.find(input => within(path.join(dataDir, "incoming", input), file)) ?? bound.inputs[0] ?? "none";
        refs.push(...await validateReferencesWithMedia([file], bound.images, path.join(dataDir, "incoming", key), media));
      }
      opts.reference_images = refs;
      const root = path.resolve(dataDir, "images");
      await fs.mkdir(root, { recursive: true });
      if (await fs.realpath(root) !== path.join(await fs.realpath(dataDir), "images")) throw new Error("图片根目录不能是符号链接");
      const threadDir = attachmentDirs(dataDir, bound.threadKey).attachDir;
      await fs.mkdir(threadDir, { recursive: true });
      if (await fs.realpath(threadDir) !== threadDir) throw new Error("会话图片目录不能是符号链接");
      const digest = createHash("sha256").update(bound.threadKey + "\n" + api.callId).digest("hex");
      const dir = path.join(threadDir, "call-" + digest.slice(0, 16));
      await fs.mkdir(dir, { recursive: true });
      if (await fs.realpath(dir) !== dir) throw new Error("生图目录不能是符号链接");
      const subfolder = "pi-" + digest.slice(0, 24);
      const uploads = referenceUploads(opts, subfolder);
      const manifest = path.join(dir, "remote-uploads.json");
      if (uploads.length && !backend.clearReferences) throw new Error("生图后端不支持参考图清理");
      if (uploads.length) await fs.writeFile(manifest, JSON.stringify(uploads), { encoding: "utf8" });
      const observed = observeImages(backend, traceKey(bound));
      const promptId = await observed.submit(opts, { filenamePrefix: subfolder, referenceSubfolder: subfolder, count: opts.count ?? 1, imageOptions: opts }, signal);
      try {
        await observed.collect(promptId, dir, signal, opts);
      } catch (err) {
        if (!(err instanceof UnknownJobError)) throw err;
        await observed.reconcile({ filenamePrefix: subfolder, count: opts.count ?? 1, imageOptions: opts }, dir, signal, async () => {});
      }
      const images = await collectNewImages(dir, new Set());
      const files = await readImageFiles(dir);
      if (!images.length || (files && (files.some(f => !f.downloaded) ||
          !(await Promise.all(files.map(f => validImageFile(path.join(dir, f.filename))))).every(Boolean)))) throw new Error("未完整收取有效图片");
      // 仅确认任务完成后清理；中断/超时保留参考图供远端继续读取。
      if (uploads.length) { await backend.clearReferences!(uploads); await fs.unlink(manifest).catch(() => undefined); }
      return { output: [{ type: "text" as const, text: JSON.stringify({ images, note: "请用 send_message 的 images 发送这些图片" }) }] };
    },
  });
}
