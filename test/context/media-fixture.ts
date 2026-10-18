import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ContextStore } from "../../src/context/store.js";
import { normalizeMessage } from "../../src/qq/policy.js";

export const MEDIA_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

/** 模拟已经完成召回的内容寻址文件与数据库行。 */
export async function mediaFixture(store: ContextStore, dir: string, scope = "group:7", id = "media", status: "ok" | "skipped" = "ok") {
  const sha256 = createHash("sha256").update(MEDIA_PNG).digest("hex");
  const file = path.join(await fs.realpath(dir), "media", sha256.slice(0, 2), sha256 + ".png");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, MEDIA_PNG);
  const [type, peer] = scope.split(":");
  store.ingest(normalizeMessage({ post_type: "message", message_type: type, group_id: type === "group" ? peer : null,
    user_id: type === "private" ? peer : "1", self_id: "2", message_id: id, time: Math.floor(Date.now() / 1000),
    message: [{ type: "image", data: {} }] })!);
  const row = store.message({ kind: "scope", scope }, id)!.row;
  store.saveMedia(row, [{ scope, message_id: id, ordinal: 1, sha256, path: file, status, reason: null, created_at: Date.now() }], "[image:" + file + "]");
  return file;
}
