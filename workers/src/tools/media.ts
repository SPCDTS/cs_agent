import type { Context } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type ToolExecutionApi, type ToolExecutionResult } from "@earendil-works/pi-durable";
import type { InboundMedia } from "../policy";
import { MediaRepository, type AssetRef } from "../media/repository";

export type MediaDeps = {
  allowed(api: ToolExecutionApi, context: Context): Promise<boolean>;
  repository(api: ToolExecutionApi, context: Context): Promise<MediaRepository>;
  lookup(messageId: string, api: ToolExecutionApi, context: Context): Promise<InboundMedia[]>;
  sandbox(api: ToolExecutionApi, context: Context): Promise<{ exportAsset(path: string, scope: string, name?: string): Promise<AssetRef> }>;
  deliver(ref: AssetRef, api: ToolExecutionApi, context: Context): Promise<unknown>;
  record?(kind: "media_recall" | "media_send", detail: object): Promise<unknown>;
};
const text = (value: string, isError = false): ToolExecutionResult => ({ ...(isError ? { isError } : {}), output: [{ type: "text", text: value }] });
function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
}
const RecallParams = Type.Object({ message_id: Type.String({ minLength: 1, maxLength: 512 }), ordinal: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }, { additionalProperties: false });
export function createMediaExtension(deps: MediaDeps) {
  async function boundary(kind: "media_recall" | "media_send", api: ToolExecutionApi, context: Context, work: () => Promise<ToolExecutionResult>) {
    if (!await deps.allowed(api, context)) return text("本回合无权访问媒体或发送附件。", true);
    try { const result = await work(); await deps.record?.(kind, { result: "ok" }); return result; }
    catch (error) {
      const code = error instanceof Error && /^[a-z_]{1,80}$/.test(error.message) ? error.message : "media_error";
      await deps.record?.(kind, { result: code });
      return text(`${code}：附件访问失败；请确认消息仍可用、来源范围正确且文件不超过10MiB。`, true);
    }
  }
  const recall = (imageOnly: boolean) => defineTool({
    name: imageOnly ? "qq_image" : "qq_attachment", replay: "safe",
    description: imageOnly ? "Recall images by message_id in the current authorized chat. Returns image content directly; ordinal selects one attachment." : "Recall an attachment by message_id in the current authorized chat; returns its private asset reference and metadata, without claiming its contents were parsed.",
    parameters: RecallParams,
    execute: (args, api, context) => boundary("media_recall", api, context, async () => {
      const repository = await deps.repository(api, context), media = await deps.lookup(args.message_id, api, context);
      const selected = media.filter(item => (!imageOnly || item.kind === "image") && (args.ordinal === undefined || item.ordinal === args.ordinal)).slice(0,5);
      if (!selected.length) return text("本会话这条消息没有可访问的附件。", true);
      const output: ToolExecutionResult["output"] = [];
      for (const item of selected) {
        const ref = item.assetId ? (await repository.get(item.assetId)).ref : await repository.importRemote({
          url: item.url ?? (item.file && /^https?:\/\//.test(item.file) ? item.file : undefined), name: item.name, kind: item.kind,
        });
        output.push({ type: "text", text: JSON.stringify(ref) });
        if (ref.kind === "image") output.push({ type: "image", data: base64((await repository.get(ref.id)).bytes), mimeType: ref.mime });
      }
      return { output };
    }),
  });
  return defineExtension({ name: "cs.media", tools: [recall(true), recall(false), defineTool({
    name: "send_file", replay: "unsafe", description: "Send a committed file from this conversation's /work workspace through the current authorized reply route. The file must be at most 10MiB.",
    parameters: Type.Object({ path: Type.String({ minLength: 1, maxLength: 1024 }), name: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })) }, { additionalProperties: false }),
    execute: (args, api, context) => boundary("media_send", api, context, async () => {
      const repository = await deps.repository(api, context), sandbox = await deps.sandbox(api, context);
      const ref = await sandbox.exportAsset(args.path, repository.scope, args.name);
      return text(JSON.stringify(await deps.deliver(ref, api, context)));
    }),
  })].map(tool => ({ ...tool, callers: ["model"] as const })) });
}
