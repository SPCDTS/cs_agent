import type { DurableObjectSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { recallMedia } from "../context";
import { id, isRecord, normalizeMedia, scopeOf, type InboundMedia, type Target } from "../policy";
import { FILE_MAX_BYTES, cleanFileName, imageMime, validScope } from "../media/model";
import { downloadMedia } from "../media/download";
import type { MediaRepository } from "../media/repository";
import type { MediaSelection } from "./media";
import { mediaStage, type MediaTrace } from "../media/diagnostics";

/** 只由宿主从已经核验的回合身份构造；scope是物理QQ会话，namespace是Thread/资产命名空间。 */
export type VerifiedMediaSource = { scope: string; namespace: string; target: Target };
export type MediaLookupBridge = {
  getMessage(messageId: string): Promise<unknown>;
  getFileAttachment(file: string): Promise<{ bytes: Uint8Array; name: string } | string>;
  getImage(file: string): Promise<{ bytes: Uint8Array; name: string }>;
  getRecord(file: string): Promise<string>;
  getFile(file: string): Promise<string>;
};
function sourceTarget(source: VerifiedMediaSource): Target {
  validScope(source.namespace);
  const target = source.target.kind === "group" ? { kind: "group" as const, groupId: source.target.groupId } : { kind: "private" as const, userId: source.target.userId };
  if (scopeOf(target) !== source.scope || source.namespace !== source.scope && (source.namespace !== "owner" || target.kind !== "private")) throw new Error("media_scope_denied");
  return target;
}
function remoteMedia(value: unknown, target: Target, messageId: string): InboundMedia[] {
  if (!isRecord(value) || id(value.message_id) !== messageId) throw new Error("media_message_mismatch");
  if (target.kind === "group") {
    if (value.message_type === "private" || id(value.group_id) !== target.groupId) throw new Error("media_scope_denied");
  } else {
    const sender = isRecord(value.sender) ? value.sender : {};
    const senderId = id(value.user_id ?? sender.user_id), recipientId = id(value.target_id ?? value.peer_id);
    const peer = senderId === target.userId ? senderId : recipientId;
    if (value.message_type === "group" || id(value.group_id) && id(value.group_id) !== "0" || peer !== target.userId) throw new Error("media_scope_denied");
  }
  return normalizeMedia(Array.isArray(value.message) ? value.message.filter(isRecord) : []);
}
/** 不接收模型target；全局get_msg只用于当前scope已经持有的消息，并再次核验返回目标。 */
export async function lookupHostMedia(input: {
  database: Pick<DurableObjectSqliteDatabase, "get">;
  bridge: MediaLookupBridge;
  source: VerifiedMediaSource;
  messageId: string;
  selection?: MediaSelection;
  trace?: MediaTrace;
}): Promise<InboundMedia[]> {
  const target = sourceTarget(input.source), trace = input.trace;
  trace?.setScope(input.source.scope);
  let media = await mediaStage(trace, "metadata", () => recallMedia(input.database, input.source.scope, input.messageId));
  if (!media.length) {
    const existing = await mediaStage(trace, "metadata", () => input.database.get<{ message_id: string }>("SELECT message_id FROM messages WHERE scope=? AND message_id=?", input.source.scope, input.messageId));
    if (!existing) return [];
    media = await mediaStage(trace, "get_msg", async () => remoteMedia(await input.bridge.getMessage(input.messageId), target, input.messageId));
  }
  return media.filter(item => (input.selection?.kind === undefined || item.kind === input.selection.kind) &&
    (input.selection?.ordinal === undefined || item.ordinal === input.selection.ordinal)).slice(0, 5);
}

/** 逐件取字节，文件在内存中只保留到其工作区写入或私有资产写入完成。 */
export async function readHostMedia(item: InboundMedia, bridge: MediaLookupBridge, repository: MediaRepository, trace: MediaTrace) {
  if (item.assetId) {
    const { ref, bytes } = await trace.run("asset_get", () => repository.get(item.assetId!));
    return { ref, bytes, name: ref.name, mime: ref.mime };
  }
  const source = await trace.run("resolve_url", async () => {
    const file = item.kind === "file" ? item.fileId ?? item.file : item.file ?? item.fileId;
    if (item.kind === "image") {
      if (!file || /^https?:\/\//i.test(file)) throw new Error("media_reference_missing");
      return trace.run("get_image", () => bridge.getImage(file));
    }
    if (item.url && !(item.kind === "file" && item.fileId)) return item.url;
    if (!file) throw new Error("media_reference_missing");
    if (/^https?:\/\//i.test(file)) return file;
    if (item.kind === "audio") return trace.run("get_record", () => bridge.getRecord(file));
    if (item.kind === "video") return trace.run("get_file", () => bridge.getFile(file));
    if (item.size !== undefined && item.size > FILE_MAX_BYTES) throw new Error("too_large");
    return trace.run("get_file", () => bridge.getFileAttachment(file));
  });
  const content = typeof source === "string" ? await downloadMedia(source, { trace }) : source;
  const name = cleanFileName(item.name || ("name" in content && content.name) || item.kind);
  return { ref: undefined, bytes: content.bytes, name,
    mime: imageMime(content.bytes) ?? ("mime" in content ? content.mime : "application/octet-stream") };
}
