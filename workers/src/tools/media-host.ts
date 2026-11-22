import type { DurableObjectSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { recallMedia } from "../context";
import { id, isRecord, normalizeMedia, scopeOf, type InboundMedia, type Target } from "../policy";
import { FILE_MAX_BYTES, validScope, type AssetRef } from "../media/model";
import type { MediaSelection } from "./media";
import { mediaStage, type MediaTrace } from "../media/diagnostics";

/** 只由宿主从已经核验的回合身份构造；scope是物理QQ会话，namespace是Thread/资产命名空间。 */
export type VerifiedMediaSource = { scope: string; namespace: string; target: Target };
export type MediaLookupBridge = {
  getMessage(messageId: string): Promise<unknown>;
  getFileAttachment(file: string, scope: string, name?: string): Promise<AssetRef | string>;
  getImage(file: string, scope: string): Promise<AssetRef>;
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
  const selected = media.filter(item => (input.selection?.kind === undefined || item.kind === input.selection.kind) &&
    (input.selection?.ordinal === undefined || item.ordinal === input.selection.ordinal)).slice(0,5);
  return Promise.all(selected.map(async item => {
    const itemTrace = trace?.forOrdinal(item.ordinal);
    return mediaStage(itemTrace, "resolve_url", async () => {
      if (item.assetId) return item;
      if (item.kind === "image") {
        const file = item.file ?? item.fileId;
        if (!file || /^https?:\/\//i.test(file)) throw new Error("media_reference_missing");
        const asset = await mediaStage(itemTrace, "get_image", () => input.bridge.getImage(file, input.source.namespace));
        return { ...item, assetId: asset.id };
      }
      const file = item.kind === "file" ? item.fileId ?? item.file : item.file ?? item.fileId;
      if (item.url && !(item.kind === "file" && item.fileId)) return item;
      if (!file) throw new Error("media_reference_missing");
      if (/^https?:\/\//i.test(file)) return { ...item, url: file };
      let url: string;
      switch(item.kind) {
        case "audio": url = await mediaStage(itemTrace, "get_record", () => input.bridge.getRecord(file)); break;
        case "video": url = await mediaStage(itemTrace, "get_file", () => input.bridge.getFile(file)); break;
        case "file": {
          if (item.size !== undefined && item.size > FILE_MAX_BYTES) throw new Error("too_large");
          const result = await mediaStage(itemTrace, "get_file", () => input.bridge.getFileAttachment(file, input.source.namespace, item.name));
          return typeof result === "string" ? { ...item, url: result } : { ...item, assetId: result.id };
        }
        default: { const exhaustive: never = item.kind; throw new Error(`invalid_media_kind:${exhaustive}`); }
      }
      // 其他附件仍由 MediaRepository.importRemote 检查公网地址、重定向与大小。
      return { ...item, url };
    });
  }));
}
