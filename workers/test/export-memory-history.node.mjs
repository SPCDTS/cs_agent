import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { exportMemoryHistory } from "../scripts/export-memory-history.mjs";

test("历史导出只读、跨命名空间隔离、完整保留版本与链接，CLI支持新文件输出", () => {
  const parent = path.resolve(process.env.EXPORT_TEST_TMP ?? tmpdir());
  const root = mkdtempSync(path.join(parent, "memory-history-export-"));
  try {
    const dbPath = path.join(root, "memory.sqlite"), db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE memories(id INTEGER PRIMARY KEY,ns TEXT,text TEXT);
      CREATE TABLE memory_versions(id INTEGER PRIMARY KEY,memory_id INTEGER,at INTEGER,by TEXT,before_json TEXT,after_json TEXT,reason TEXT);
      CREATE TABLE memory_links(from_id INTEGER,to_id INTEGER,rel TEXT,created_at INTEGER);
      CREATE TABLE memory_proposals(id INTEGER PRIMARY KEY,ns TEXT,text TEXT);
      INSERT INTO memories VALUES (1,'owner','中文资料'),(2,'owner','中文资料二'),(3,'private:10000003','其他会话');
      INSERT INTO memory_links VALUES(1,2,'related',1),(1,3,'related',1);
      INSERT INTO memory_proposals VALUES(1,'owner','待确认画像'),(2,'private:10000003','私聊画像');`);
    db.prepare("INSERT INTO memory_versions VALUES(1,1,1,'dashboard',NULL,?,'remember')").run(JSON.stringify({ id: 1, ns: "owner", text: "历史中文" }));
    db.prepare("INSERT INTO memory_versions VALUES(2,3,1,'dashboard',NULL,?,'remember')").run(JSON.stringify({ id: 3, ns: "private:10000003", text: "私聊历史" }));
    db.close();
    const before = readFileSync(dbPath), output = path.join(root, "export.json");
    const bundle = exportMemoryHistory("owner", root, "stable-source");
    assert.equal(bundle.memories.length, 2); assert.equal(bundle.versions.length, 1);
    assert.equal(bundle.links.length, 1); assert.equal(bundle.proposals.length, 1);
    assert.equal(bundle.source, "stable-source");
    const script = fileURLToPath(new URL("../scripts/export-memory-history.mjs", import.meta.url));
    execFileSync(process.execPath, [script, "--ns", "owner", "--data-dir", root, "--source", "stable-source", "--output", output], { stdio: "pipe" });
    assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), JSON.parse(JSON.stringify(bundle)));
    assert.deepEqual(readFileSync(dbPath), before);
    assert.throws(() => execFileSync(process.execPath, [script, "--ns", "owner", "--data-dir", root, "--output", output], { stdio: "pipe" }));
    assert.equal(exportMemoryHistory("private:10000003", root).versions.length, 1);
    assert.throws(() => exportMemoryHistory("../owner", root));
    writeFileSync(path.join(root, "untouched.txt"), "中文保留", "utf8");
  } finally {
    if (path.dirname(path.resolve(root)) !== parent || !path.basename(root).startsWith("memory-history-export-")) throw new Error("临时目录越界");
    rmSync(root, { recursive: true, force: true });
  }
});
