import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { exportMemory } from "../scripts/export-memory.mjs";

// node:sqlite 不能在 workerd 中运行，导出器单独用真实 Node 与临时 SQLite 做端到端验证。
test("导出 UTF-8 画像、原 id 与来源，只包含指定命名空间，CLI stdout 可直接作为导入 JSON", () => {
  const root = mkdtempSync(path.join(process.env.EXPORT_TEST_TMP ?? tmpdir(), "memory-export-"));
  try {
    const data = path.join(root, "data");
    mkdirSync(path.join(data, "memory", "owner"), { recursive: true });
    mkdirSync(path.join(data, "memory", "group_200000001"), { recursive: true });
    writeFileSync(path.join(data, "memory", "owner", "profile.md"), "中文画像\n", "utf8");
    writeFileSync(path.join(data, "memory", "group_200000001", "profile.md"), "群画像", "utf8");
    const db = new DatabaseSync(path.join(data, "memory.sqlite"));
    db.exec("CREATE TABLE memories (id INTEGER PRIMARY KEY, ns TEXT, kind TEXT, text TEXT, author TEXT, source_message_id TEXT)");
    db.prepare("INSERT INTO memories VALUES (1234, 'owner', 'fact', '中文条目', 'dashboard', '90000001')").run();
    db.prepare("INSERT INTO memories VALUES (2000, 'group:200000001', 'rule', '群规', 'dashboard', NULL)").run();
    db.close();
    const original = readFileSync(path.join(data, "memory.sqlite"));
    const script = fileURLToPath(new URL("../scripts/export-memory.mjs", import.meta.url));
    const output = execFileSync(process.execPath, [script, "owner"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    assert.deepEqual(JSON.parse(output), { ns: "owner", profile: { text: "中文画像\n" }, memories: [
      { id: 1234, ns: "owner", kind: "fact", text: "中文条目", author: "dashboard", source_message_id: "90000001" },
    ] });
    assert.equal(exportMemory("group:200000001", data).profile.text, "群画像");
    assert.deepEqual(exportMemory("private:10000003", data), { ns: "private:10000003", memories: [] });
    assert.deepEqual(readFileSync(path.join(data, "memory.sqlite")), original);
    assert.throws(() => exportMemory("../owner", data));
    assert.throws(() => execFileSync(process.execPath, [script], { cwd: root, stdio: "pipe" }));
  } finally {
    // 仅删除由本测试创建且仍位于指定临时根目录内的夹具目录。
    const parent = path.resolve(process.env.EXPORT_TEST_TMP ?? tmpdir());
    if (path.dirname(path.resolve(root)) !== parent || !path.basename(root).startsWith("memory-export-")) throw new Error("临时目录越界");
    rmSync(root, { recursive: true, force: true });
  }
});
