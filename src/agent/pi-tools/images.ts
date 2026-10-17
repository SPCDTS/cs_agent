import { observeImages } from "../../obs/image.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineTool, type Harness } from "@earendil-works/pi-durable";
import { ASPECTS, SIZES, validateImageOptions, type ImageOptions } from "../image-options.js";
import { referenceUploads, ticketImageDir, type ImageBackend } from "../image-gen.js";
import { validateReferences } from "../image-references.js";
import { collectNewImages } from "../image-collect.js";
import { readPendingImages, savePendingImage, type PendingImageJob } from "../image-pending.js";
import { UnknownJobError } from "../image-gen.js";
import { readImageFiles, validImageFile } from "../image-files.js";
import { PiRequestDoc } from "./request.js";

export type PiImageBackend = Pick<ImageBackend, "name" | "submit" | "collect" | "reconcile" | "clearReferences">;

/** 生图不是安全重放操作：中断后由 pi-durable 返回 interrupted，不盲目再提交。 */
export function imageTool(dataDir: string, backend: PiImageBackend, getHarness: () => Harness) {
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
      let opts: ImageOptions = validateImageOptions(args);
      if (opts.reference_images?.some(file => !request.images.includes(file))) throw new Error("参考图只能选择本票据提供的文件");
      opts.reference_images = await validateReferences(opts.reference_images ?? [], request.images,
        path.join(dataDir, "incoming", request.ticket));
      const root = path.resolve(dataDir, "images");
      await fs.mkdir(root, { recursive: true });
      if (await fs.realpath(root) !== path.join(await fs.realpath(dataDir), "images")) throw new Error("图片根目录不能是符号链接");
      const ticketDir = ticketImageDir(root, request.ticket);
      await fs.mkdir(ticketDir, { recursive: true });
      if (await fs.realpath(ticketDir) !== ticketDir) throw new Error("票据图片目录不能是符号链接");
      const markers = await readPendingImages(ticketDir);
      const saved = request.imageJobs?.find(j => j.status !== "done") ?? request.imageJobs?.find(j => j.ordinal === call.ordinal);
      const ordinal = saved?.ordinal ?? call.ordinal;
      const dir = path.join(ticketDir, "call-" + ordinal);
      await fs.mkdir(dir, { recursive: true });
      if (await fs.realpath(dir) !== dir) throw new Error("生图目录不能是符号链接");
      const subfolder = "pi-" + createHash("sha256").update(request.ticket).digest("hex").slice(0, 24) + "-" + ordinal;
      let job: PendingImageJob = markers.find(j => j.filenamePrefix === subfolder) ?? saved ?? {
        filenamePrefix: subfolder, options: opts, callDir: dir, backend: backend.name, submittedAt: Date.now(), status: "intent",
      };
      const fresh = !saved && !markers.some(j => j.filenamePrefix === subfolder);
      opts = job.options;
      const persist = async () => {
        // 文件镜像先写；即使 harness 正在关闭，prompt_id 也可由下一次工具或 lateImages 读回。
        const { ordinal: _ordinal, ...value } = job as PendingImageJob & { ordinal?: number };
        await savePendingImage(ticketDir, value);
        await getHarness().commit(async tx => {
          const doc = await tx.doc(PiRequestDoc, api.conversationId);
          if (doc.ticket !== request.ticket) throw new Error("生图绑定已变更");
          doc.imageJobs ??= [];
          const index = doc.imageJobs.findIndex(j => j.ordinal === ordinal);
          if (index < 0) doc.imageJobs.push({ ...job, ordinal }); else doc.imageJobs[index] = { ...job, ordinal };
        }, BACKGROUND_CONTEXT);
      };
      const uploads = referenceUploads(opts, subfolder);
      const manifest = path.join(dir, "remote-uploads.json");
      if (uploads.length && !backend.clearReferences) throw new Error("生图后端不支持参考图清理");
      if (fresh) {
        await persist();
        if (uploads.length) await fs.writeFile(manifest, JSON.stringify(uploads), { encoding: "utf8", flag: "wx" });
        job.prompt_id = await observeImages(backend, request.ticket).submit(opts, { filenamePrefix: subfolder, referenceSubfolder: subfolder, count: opts.count ?? 1, imageOptions: opts }, signal);
        job.status = "submitted";
        await persist();
      }
      if (job.status !== "done") {
        try {
          if (!job.prompt_id) throw new UnknownJobError("intent");
          await observeImages(backend, request.ticket).collect(job.prompt_id, dir, signal, opts);
        } catch (err) {
          if (!(err instanceof UnknownJobError)) throw err;
          await observeImages(backend, request.ticket).reconcile({ filenamePrefix: subfolder, count: opts.count ?? 1, imageOptions: opts }, dir, signal, async step => {
            if (step.prompt_id) { job.prompt_id = step.prompt_id; job.status = "submitted"; await persist(); }
          });
        }
        const images = await collectNewImages(dir, new Set());
        const files = await readImageFiles(dir);
        if (!images.length || (files && (files.some(f => !f.downloaded) ||
            !(await Promise.all(files.map(f => validImageFile(path.join(dir, f.filename))))).every(Boolean)))) throw new Error("未完整收取有效图片");
        job = { ...job, status: "done", remoteTerminal: true };
        await persist();
      }
      // 仅确认任务完成后清理；中断/超时保留参考图供远端继续读取。
      if (uploads.length) { await backend.clearReferences!(uploads); await fs.unlink(manifest).catch(() => undefined); }
      const images = await collectNewImages(dir, new Set());
      return { output: [{ type: "text" as const, text: "已生成 " + images.length + " 张图片，将自动附带。" }] };
    },
  });
}
