import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepareStorage, workspaceStorage } from "../src/storage.ts";

test("专用持久目录按工作区复用，凭据、checkout 与其他设备不能混入", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cs-storage-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const input = { dataDir: path.join(root, "data"), state: path.join(root, "state"), deviceId: "device", protectedPaths: [path.join(root, "checkout")] };
  const first = await workspaceStorage({ ...input, workspace: "owner" });
  await fs.writeFile(path.join(first.work, "keep.txt"), "持久文件", "utf8");
  const next = await workspaceStorage({ ...input, workspace: "owner" });
  assert.equal(await fs.readFile(path.join(next.work, "keep.txt"), "utf8"), "持久文件");
  assert.notEqual((await workspaceStorage({ ...input, workspace: "other" })).work, first.work);
  await assert.rejects(prepareStorage({ ...input, dataDir: input.state }), /overlaps/);
  await assert.rejects(prepareStorage({ ...input, dataDir: path.join(root, "checkout", "subdir") }), /overlaps/);
  await assert.rejects(prepareStorage({ ...input, dataDir: root }), /overlaps/);
  await assert.rejects(prepareStorage({ ...input, deviceId: "other" }), /another_device/);
  const existing = path.join(root, "existing"); await fs.mkdir(existing); await fs.writeFile(path.join(existing, "keep"), "existing");
  await assert.rejects(prepareStorage({ ...input, dataDir: existing }), /must_be_empty/);
  const link = path.join(root, "link"); await fs.symlink(input.dataDir, link, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(prepareStorage({ ...input, dataDir: link }), /no_links/);
  await fs.unlink(link);
});
