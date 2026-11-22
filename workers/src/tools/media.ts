import type { Context } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type ToolExecutionApi, type ToolExecutionResult } from "@earendil-works/pi-durable";
import type { InboundMedia } from "../policy";
import { MediaTrace, mediaErrorDetail, type MediaLog } from "../media/diagnostics";
import { MediaRepository, type AssetRef } from "../media/repository";
import { ResourceIdSchema } from "../sandbox/resources";
import { workPath } from "../sandbox/client";
import { relativeWorkPath } from "../sandbox/workspace";
import { sha256 } from "../media/model";
import { readHostMedia, type MediaLookupBridge } from "./media-host";

export type MediaSelection = { ordinal?: number; kind?: InboundMedia["kind"] };
export type MediaDeps = {
  bridge: MediaLookupBridge;
  canWriteWorkspace(api: ToolExecutionApi, context: Context): Promise<boolean>;
  saveAttachment(path: string, bytes: Uint8Array, api: ToolExecutionApi, context: Context): Promise<void>;
  allowed(api: ToolExecutionApi, context: Context, kind: "media_recall" | "media_send"): Promise<boolean>;
  scope?(api: ToolExecutionApi, context: Context): Promise<string>;
  repository(api: ToolExecutionApi, context: Context): Promise<MediaRepository>;
  lookup(messageId: string, api: ToolExecutionApi, context: Context, selection?: MediaSelection, trace?: MediaTrace): Promise<InboundMedia[]>;
  sandbox(api: ToolExecutionApi, context: Context, sandboxId?: string): Promise<{ exportAsset(path: string, scope: string, name?: string): Promise<AssetRef> }>;
  deliver(ref: AssetRef, api: ToolExecutionApi, context: Context): Promise<unknown>;
  record?(kind: "media_recall" | "media_send", detail: object): Promise<unknown>;
  log?: MediaLog;
};
const text = (value: string, isError = false): ToolExecutionResult => ({ ...(isError ? { isError } : {}), output: [{ type: "text", text: value }] });
function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
}
const recallFields = { message_id: Type.String({ minLength: 1, maxLength: 512 }), ordinal: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) };
const pathEncoder = new TextEncoder();
function attachmentPath(path: string): string {
  const relative = relativeWorkPath(workPath(path));
  if (path.endsWith("/") || relative.split("/").some(part => pathEncoder.encode(part).length > 255)) throw new Error("path_denied");
  return "/work/" + relative;
}
export function createMediaExtension(deps: MediaDeps) {
  async function audit(kind: "media_recall" | "media_send", trace: MediaTrace, detail: object) {
    if (!deps.record) return;
    try { await trace.run("audit", () => deps.record!(kind, { ...trace.summary(), ...detail })); }
    catch { /* run已经输出脱敏失败事件；不重试，不覆盖原始业务结果。 */ }
  }
  async function boundary(kind: "media_recall" | "media_send", api: ToolExecutionApi, context: Context,
    input: { messageId?: string; ordinal?: number }, work: (trace: MediaTrace) => Promise<ToolExecutionResult>) {
    const trace = new MediaTrace(input, deps.log);
    let result: ToolExecutionResult;
    try {
      await trace.run("authorize", async () => {
        if (!await deps.allowed(api, context, kind)) throw new Error("media_access_denied");
        if (deps.scope) trace.setScope(await deps.scope(api, context));
      });
      result = await trace.run(kind === "media_recall" ? "recall" : "send", () => work(trace));
    } catch (error) {
      const detail = mediaErrorDetail(error);
      await audit(kind, trace, { result: detail.code, ...detail });
      const message = detail.code === "napcat_image_content_missing"
        ? "NapCat 未返回图片内容，请检查本机媒体回传设置。"
        : detail.code === "napcat_file_content_missing" ? "请在 NapCat 启用 enableLocalFile2Url，让 get_file 回传文件内容。"
        : detail.code === "media_access_denied" ? "本回合无权访问媒体或发送附件。"
        : detail.code === "media_not_found" ? "本会话这条消息没有可访问的附件。"
        : detail.code === "attachment_path_ambiguous" ? "指定文件路径时请用 ordinal 选择一个附件。"
        : detail.code === "workspace_conflict" ? "目标路径已有其他内容，请为附件选择其他路径。"
        : "附件访问失败；请按错误码与诊断编号排查。";
      return text(`${detail.code}：${message}（traceId: ${trace.id}）`, true);
    }
    // 已取得资产的成功结果不会因为审计失败而丢失，避免诱发重复导入/发送。
    await audit(kind, trace, { result: "ok" });
    return result;
  }
  const recall = (imageOnly: boolean) => defineTool({
    name: imageOnly ? "qq_image" : "qq_attachment", replay: "safe",
    description: imageOnly ? "Recall images by message_id in the current authorized chat. Returns image content directly; ordinal selects one attachment." : "Retrieve attachments from this chat. In a writable workspace, files are saved and the result includes the committed path for Code Mode. Set path to choose a filename under /work (relative paths are accepted). For multiple attachments, use ordinal with path. Omit path to use automatic filenames. Read-only chats receive private asset references.",
    parameters: Type.Object({ ...recallFields, ...(imageOnly ? {} : { path: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })) }) }, { additionalProperties: false }),
    execute: (args, api, context) => boundary("media_recall", api, context, { messageId: args.message_id, ordinal: args.ordinal }, async trace => {
      const repository = await trace.run("repository", () => deps.repository(api, context));
      const writable = !imageOnly && await deps.canWriteWorkspace(api, context);
      if (args.path !== undefined && !writable) throw new Error("permission_denied");
      const destination = typeof args.path === "string" ? attachmentPath(args.path) : undefined;
      const media = await trace.run("lookup", () => deps.lookup(args.message_id, api, context, { ordinal: args.ordinal, ...(imageOnly ? { kind: "image" } : {}) }, trace));
      const selected = media.filter(item => (!imageOnly || item.kind === "image") && (args.ordinal === undefined || item.ordinal === args.ordinal)).slice(0,5);
      if (!selected.length) throw new Error("media_not_found");
      if (destination && selected.length > 1) throw new Error("attachment_path_ambiguous");
      const output: ToolExecutionResult["output"] = [];
      for (const item of selected) {
        const itemTrace = trace.forOrdinal(item.ordinal);
        const { ref, bytes, name, mime } = await readHostMedia(item, deps.bridge, repository, itemTrace);
        const kind = ref?.kind ?? item.kind;
        if (writable) {
          const filename = [".", "..", ".git", ".wrangler", "node_modules"].includes(name) || pathEncoder.encode(name).length > 255 ? "attachment" : name;
          const path = destination ?? attachmentPath(`attachments/${await sha256(bytes)}/${filename}`);
          await itemTrace.run("workspace_write", () => deps.saveAttachment(path, bytes, api, context));
          output.push({ type: "text", text: JSON.stringify({ path, name, kind, bytes: bytes.byteLength, mime }) });
        } else {
          const asset = ref ?? await itemTrace.run("store", () => repository.put({ bytes, name, mime, kind }));
          output.push({ type: "text", text: JSON.stringify(asset) });
        }
        if (kind === "image") output.push({ type: "image", data: base64(bytes), mimeType: mime });
      }
      return { output };
    }),
  });
  return defineExtension({ name: "cs.media", tools: [recall(true), recall(false), defineTool({
    name: "send_file", replay: "unsafe", description: "Send a committed file from this conversation's /work workspace through the current authorized reply route. The file must be at most 10MiB. Owner turns may specify sandboxId to send from an owned Cloudflare resource, including a subagent's assigned workspace. Omit it for the current workspace.",
    parameters: Type.Object({ path: Type.String({ minLength: 1, maxLength: 1024 }), name: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })), sandboxId: Type.Optional(ResourceIdSchema) }, { additionalProperties: false }),
    execute: (args, api, context) => boundary("media_send", api, context, {}, async trace => {
      const repository = await trace.run("repository", () => deps.repository(api, context)), sandbox = await deps.sandbox(api, context, args.sandboxId);
      const ref = await trace.run("export", () => sandbox.exportAsset(args.path, repository.scope, args.name));
      return text(JSON.stringify(await trace.run("deliver", () => deps.deliver(ref, api, context))));
    }),
  })].map(tool => ({ ...tool, callers: ["model"] as const })) });
}
