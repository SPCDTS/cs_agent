import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { exportMessages } from "../scripts/export-messages.mjs";

// node:sqlite 不能在 workerd 中运行；用 Docker 版的表结构建临时库，验证 CLI 输出就是导入端点的请求体。
test("导出单个会话的消息与摘要：level 改名 kind，丢弃 outbox_key/status，清掉内联图片的 detail，原库不变", () => {
  const root = mkdtempSync(path.join(process.env.EXPORT_TEST_TMP ?? tmpdir(), "messages-export-"));
  try {
    const data = path.join(root, "data");
    mkdirSync(data);
    const db = new DatabaseSync(path.join(data, "qq-messages.sqlite"));
    db.exec(`CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL, message_id TEXT NOT NULL, time INTEGER NOT NULL,
      user_id TEXT NOT NULL, nickname TEXT NOT NULL DEFAULT '', is_self INTEGER NOT NULL DEFAULT 0, text TEXT NOT NULL DEFAULT '', reply_to_id TEXT,
      action TEXT, detail TEXT, outbox_key TEXT, status TEXT, image_count INTEGER, UNIQUE (scope, message_id));
      CREATE TABLE summaries (id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL, level TEXT NOT NULL, period_start INTEGER NOT NULL,
      period_end INTEGER NOT NULL, text TEXT NOT NULL, msg_count INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
      CREATE TABLE scope_names (scope TEXT PRIMARY KEY, name TEXT NOT NULL, updated_at INTEGER NOT NULL);`);
    const insert = db.prepare(`INSERT INTO messages (scope, message_id, time, user_id, nickname, is_self, text, reply_to_id, action, detail, outbox_key, status, image_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    insert.run("group:200000001", "2", 1700000002, "10000000", "机器人", 1, "画好了", "1", "generate_image",
      `{"image":"data:image/png;base64,${"A".repeat(40)}"}`, "outbox-1", "sent", 1);
    insert.run("group:200000001", "1", 1700000001, "10000004", "成员", 0, "画一张图", null, null, '{"note":"普通备注"}', null, null, 0);
    insert.run("group:200000002", "3", 1700000003, "10000004", "成员", 0, "别的群", null, null, null, null, null, 0);
    db.prepare("INSERT INTO summaries (scope, level, period_start, period_end, text, msg_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("group:200000001", "day", 1699891200, 1699977600, "当天聊了画图", 2, 1699980000);
    db.prepare("INSERT INTO scope_names VALUES (?, ?, ?)").run("group:200000001", "测试群", 1700000000);
    db.close();
    const original = readFileSync(path.join(data, "qq-messages.sqlite"));

    const script = fileURLToPath(new URL("../scripts/export-messages.mjs", import.meta.url));
    const output = execFileSync(process.execPath, [script, "group:200000001"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    assert.deepEqual(JSON.parse(output), { scope: "group:200000001", name: "测试群",
      messages: [
        { message_id: "1", time: 1700000001, user_id: "10000004", nickname: "成员", is_self: 0, text: "画一张图", reply_to_id: null, action: null,
          detail: '{"note":"普通备注"}', image_count: 0 },
        { message_id: "2", time: 1700000002, user_id: "10000000", nickname: "机器人", is_self: 1, text: "画好了", reply_to_id: "1", action: "generate_image",
          detail: null, image_count: 1 },
      ],
      summaries: [{ kind: "day", period_start: 1699891200, period_end: 1699977600, text: "当天聊了画图", msg_count: 2, created_at: 1699980000 }] });
    assert.deepEqual(exportMessages("private:10000003", data), { scope: "private:10000003", messages: [], summaries: [] });
    assert.deepEqual(readFileSync(path.join(data, "qq-messages.sqlite")), original);
    assert.throws(() => exportMessages("owner", data));
    assert.throws(() => execFileSync(process.execPath, [script], { cwd: root, stdio: "pipe" }));
  } finally {
    // 仅删除由本测试创建且仍位于指定临时根目录内的夹具目录。
    const parent = path.resolve(process.env.EXPORT_TEST_TMP ?? tmpdir());
    if (path.dirname(path.resolve(root)) !== parent || !path.basename(root).startsWith("messages-export-")) throw new Error("临时目录越界");
    rmSync(root, { recursive: true, force: true });
  }
});
