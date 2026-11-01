import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { workspaceControl } from "../sandbox/workspace.mjs";
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
async function fixture(work) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-workspace-")), root = path.join(base, "work");
  await fs.mkdir(root); const workspace = workspaceControl({ root, own: async () => {} });
  try { await work({ root, workspace }); }
  finally { assert.equal(path.dirname(root), base); await fs.rm(base, { recursive: true, force: true }); }
}
test("本地快照与两阶段恢复保留二进制、中文 CRLF 和空目录", () => fixture(async ({ root, workspace }) => {
  const bytes = Buffer.from([137,80,78,71,13,10,26,10,0,255,14]);
  await fs.mkdir(path.join(root, "empty")); await fs.writeFile(path.join(root, "image.png"), bytes); await fs.writeFile(path.join(root, "text.txt"), "中文\r\nline");
  const snapshot = await workspace.scan(); assert.equal(snapshot.files.length, 2); assert.deepEqual(snapshot.directories, ["empty"]);
  assert.equal(snapshot.files.find(file => file.path === "image.png").sha256, digest(bytes));
  const stored = new Map(await Promise.all(snapshot.files.map(async file => [file.path, await fs.readFile(path.join(root, file.path))])));
  const { id } = await workspace.start(snapshot); await fs.writeFile(path.join(root, "later.txt"), "should disappear");
  for (const file of snapshot.files) await workspace.put(id, file.path, stored.get(file.path));
  assert.deepEqual(await workspace.commit(id), { restored: true });
  assert.deepEqual(await fs.readFile(path.join(root, "image.png")), bytes);
  assert.equal(await fs.readFile(path.join(root, "text.txt"), "utf8"), "中文\r\nline");
  assert.deepEqual(await fs.readdir(root), ["empty", "image.png", "text.txt"]);
}));
test("新缓存不计入 R2 配额，旧 manifest 已追踪缓存继续保留", () => fixture(async ({ root, workspace }) => {
  for (const cache of ["node_modules", ".git", ".wrangler"]) {
    await fs.mkdir(path.join(root, cache)); await fs.writeFile(path.join(root, cache, "large.bin"), Buffer.alloc(10 * 1024 * 1024 + 1));
  }
  await fs.mkdir(path.join(root, "project", "node_modules"), { recursive: true });
  await fs.writeFile(path.join(root, "project", "node_modules", "old.txt"), "tracked");
  await fs.writeFile(path.join(root, "project", "node_modules", "new.txt"), "cache");
  assert.equal((await workspace.scan()).files.length, 0);
  const snapshot = await workspace.scan(["project", "project/node_modules", "project/node_modules/old.txt"]);
  assert.deepEqual(snapshot.files.map(file => file.path), ["project/node_modules/old.txt"]);
  assert.equal(await fs.readFile(path.join(root, "project", "node_modules", "new.txt"), "utf8"), "cache");
  await assert.rejects(workspace.scan(["node_modules", "node_modules/large.bin"]), error => error.message === "workspace_quota");
}));
test("快照拒绝链接、单文件和源文件总量超限", () => fixture(async ({ root, workspace }) => {
  await fs.writeFile(path.join(root, "large.bin"), Buffer.alloc(10 * 1024 * 1024 + 1));
  await assert.rejects(workspace.scan(), error => error.message === "workspace_quota" && error.issues.some(issue => issue.code === "file_too_large"));
  await fs.unlink(path.join(root, "large.bin"));
  for (let i = 0; i < 6; i++) await fs.writeFile(path.join(root, `part${i}`), Buffer.alloc(10 * 1024 * 1024));
  await assert.rejects(workspace.scan(), error => error.issues.some(issue => issue.code === "workspace_too_large"));
}));
test("恢复缺少、损坏 blob 或越界时保留原工作集", () => fixture(async ({ root, workspace }) => {
  await fs.writeFile(path.join(root, "keep.txt"), "keep");
  const files = [{ path: "new.bin", bytes: 2, sha256: digest(Buffer.from([1,2])), mime: "application/octet-stream", mode: 420 }];
  const { id } = await workspace.start({ files, directories: [], totalBytes: 2 });
  await assert.rejects(workspace.commit(id), /restore_incomplete/);
  await assert.rejects(workspace.put(id, "new.bin", Buffer.from([9,9])), /blob_corrupt/);
  await assert.rejects(workspace.start({ files: [{ ...files[0], path: "../escape" }], directories: [] }), /path_denied/);
  assert.equal(await fs.readFile(path.join(root, "keep.txt"), "utf8"), "keep");
}));
