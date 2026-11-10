import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { prepareResourceFiles } from "../src/resource-files.ts";

test("按文件复制整个来源，包括根仓库、未提交文件、依赖和二进制；目标独立可写", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "resource-files-")), source = path.join(root, "source"), target = path.join(root, "target");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(source, ".git"), { recursive: true });
  await fs.mkdir(path.join(source, "node_modules", "dep"), { recursive: true });
  const files = { "README.md": "未提交修改", "untracked.txt": "未跟踪", ".git/HEAD": "ref: refs/heads/main", "node_modules/dep/index.js": "dependency" };
  for (const [file, text] of Object.entries(files)) await fs.writeFile(path.join(source, file), text, "utf8");
  await fs.writeFile(path.join(source, "binary.bin"), Buffer.from([0, 255, 1]));
  await prepareResourceFiles(target, source);
  for (const [file, text] of Object.entries(files)) assert.equal(await fs.readFile(path.join(target, file), "utf8"), text);
  assert.deepEqual(await fs.readFile(path.join(target, "binary.bin")), Buffer.from([0, 255, 1]));
  await fs.writeFile(path.join(target, ".git/HEAD"), "child-branch", "utf8");
  assert.equal(await fs.readFile(path.join(source, ".git/HEAD"), "utf8"), files[".git/HEAD"]);
  await assert.rejects(prepareResourceFiles(source, source), /overlap/);
  await assert.rejects(prepareResourceFiles(path.join(source, "inside"), source), /overlap/);
});

test("复制拒绝目录链接且不会沿目标链接删除外部文件", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "resource-links-")), source = path.join(root, "source"), target = path.join(root, "target"), outside = path.join(root, "outside");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const dir of [source, target, outside]) await fs.mkdir(dir);
  await fs.writeFile(path.join(outside, "keep.txt"), "保留", "utf8");
  const kind = process.platform === "win32" ? "junction" : "dir";
  await fs.symlink(outside, path.join(source, "link"), kind);
  await assert.rejects(prepareResourceFiles(target, source), /links_not_supported/);
  await fs.unlink(path.join(source, "link"));
  await fs.symlink(outside, path.join(target, "link"), kind);
  await assert.rejects(prepareResourceFiles(target, source), /links_not_supported/);
  assert.equal(await fs.readFile(path.join(outside, "keep.txt"), "utf8"), "保留");
  await fs.unlink(path.join(target, "link"));
});
