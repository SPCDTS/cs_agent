import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { pathToFileURL } from "node:url";

// detail 里偶有内联图片；data: URI 与长 base64 串对召回没有用，只会撑大导入请求。
const DATA_URI = /data:[\w.+-]+\/[\w.+-]+;base64,/i;
const BASE64_RUN = /[A-Za-z0-9+/]{256,}={0,2}/;
const cleanDetail = detail => typeof detail === "string" && !DATA_URI.test(detail) && !BASE64_RUN.test(detail) ? detail : null;
const nullableText = value => value === null || value === undefined ? null : String(value);

export function exportMessages(scope, dataDir = path.resolve("data")) {
  if (!/^(?:group|private):[1-9][0-9]{4,15}$/.test(scope)) throw new Error("scope 必须是 group:<群号> 或 private:<QQ号>");
  // 只读打开，避免导出过程创建空库或改写 Docker 的原始数据。
  const db = new DatabaseSync(path.join(dataDir, "qq-messages.sqlite"), { readOnly: true });
  try {
    const name = db.prepare("SELECT name FROM scope_names WHERE scope = ?").get(scope)?.name;
    // outbox_key、status 只对 Docker 的发件箱有意义，Workers 的 messages 表没有这两列。
    const messages = db.prepare(`SELECT message_id, time, user_id, nickname, is_self, text, reply_to_id, action, detail, image_count
      FROM messages WHERE scope = ? ORDER BY time, id`).all(scope).map(row => ({
      message_id: String(row.message_id), time: Number(row.time), user_id: String(row.user_id), nickname: row.nickname ?? "",
      is_self: row.is_self ? 1 : 0, text: row.text ?? "", reply_to_id: nullableText(row.reply_to_id), action: nullableText(row.action),
      detail: cleanDetail(row.detail), image_count: row.image_count === null ? null : Number(row.image_count),
    }));
    const summaries = db.prepare(`SELECT level AS kind, period_start, period_end, text, msg_count, created_at
      FROM summaries WHERE scope = ? ORDER BY period_start, level`).all(scope).map(row => ({ ...row }));
    return { scope, ...(name ? { name } : {}), messages, summaries };
  } finally { db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) throw new Error("usage");
    process.stdout.write(JSON.stringify(exportMessages(process.argv[2])) + "\n", "utf8");
  } catch {
    // 错误只给操作提示，不能把聊天正文或号码写进诊断。
    process.stderr.write("导出失败：请在仓库根目录执行 node workers/scripts/export-messages.mjs <group:群号|private:QQ号>，并检查 data/qq-messages.sqlite。\n", "utf8");
    process.exitCode = 1;
  }
}
