import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { exportSchedules } from "../scripts/export-schedules.mjs";

test("只读还原基础版本和增量，保留运行历史及累计次数，覆盖必须命中现有任务", () => {
  const root = mkdtempSync(path.join(tmpdir(), "schedule-export-"));
  try {
    const file = path.join(root, "agent.sqlite"), db = new DatabaseSync(file);
    db.exec("CREATE TABLE documents (id INTEGER PRIMARY KEY, kind TEXT, retired_at INTEGER); CREATE TABLE document_revisions (document_id INTEGER, seq INTEGER, kind TEXT, version INTEGER, content TEXT)");
    const schedule = { id: "old-id", name: "中文早报", status: "active", prompt: "旧路径", runs: [] };
    const doc = db.prepare("INSERT INTO documents VALUES (?, ?, NULL)"), revision = db.prepare("INSERT INTO document_revisions VALUES (?, ?, ?, 1, ?)");
    doc.run(1, JSON.stringify("cs.schedules")); doc.run(2, JSON.stringify("cs.schedule.runtime"));
    revision.run(1, 1, "base", JSON.stringify({ schedules: { "old-id": schedule } }));
    revision.run(1, 2, "delta", JSON.stringify([["p", ["schedules", "old-id", "runs"], 0, 0, [{ status: "sent", note: "已发送" }]],
      ["s", ["schedules", "old-id", "status"], "paused"]]));
    revision.run(2, 1, "base", JSON.stringify({ ordinals: { "old-id": 9 } }));
    db.close();
    const before = readFileSync(file);
    assert.deepEqual(exportSchedules(root), { dryRun: true, schedules: [{ ...schedule, status: "paused", runs: [{ status: "sent", note: "已发送" }], fire_count: 9 }] });
    assert.equal(exportSchedules(root, { "old-id": "read_skill 云端技能" }).schedules[0].prompt, "read_skill 云端技能");
    assert.throws(() => exportSchedules(root, { missing: "不能误覆盖" }));
    assert.equal(exportSchedules(root).schedules[0].prompt, "旧路径");
    assert.deepEqual(readFileSync(file), before);
  } finally {
    if (path.dirname(path.resolve(root)) !== path.resolve(tmpdir()) || !path.basename(root).startsWith("schedule-export-")) throw new Error("临时目录越界");
    rmSync(root, { recursive: true, force: true });
  }
});
