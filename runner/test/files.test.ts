import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { atomicJson, readJson } from "../src/files.ts";
test("宿主 journal 覆写保留中文结果且不留下临时文件", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cs-agent-journal-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "journal.json");
  await atomicJson(file, { text: "中文", state: "started" });
  await atomicJson(file, { text: "中文结果", state: "finished" });
  assert.deepEqual(await readJson(file), { text: "中文结果", state: "finished" });
  assert.deepEqual(await fs.readdir(root), ["journal.json"]);
});
