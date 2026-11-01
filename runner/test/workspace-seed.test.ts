import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { command } from "../src/wsb.ts";
import { seedWorkspace } from "../src/workspace-seed.ts";

test("真实 Git 独立 clone 固定提交、保留远程地址；重试不覆盖修改或共享 node_modules", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cs-agent-seed-")), source = path.join(root, "source"), work = path.join(root, "child"), repo = path.join(source, "repo");
  const git = process.platform === "win32" ? "git.exe" : "git";
  await fs.mkdir(repo, { recursive: true });
  try {
    await command(git, ["init", repo]);
    await fs.writeFile(path.join(repo, "hello.txt"), "已提交内容", "utf8");
    await command(git, ["-C", repo, "add", "hello.txt"]);
    await command(git, ["-C", repo, "-c", "user.name=fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "fixture"]);
    await command(git, ["-C", repo, "remote", "add", "origin", "https://github.com/example/repo.git"]);
    const commit = (await command(git, ["-C", repo, "rev-parse", "HEAD"])).trim();
    await fs.writeFile(path.join(repo, "hello.txt"), "父工作区未提交修改", "utf8");
    await fs.mkdir(path.join(repo, "node_modules"));
    const options = { source, work, sourceId: "parent", workspace: "child", git };
    assert.match(await seedWorkspace(options), /已准备独立仓库/);
    const copy = path.join(work, "repo");
    assert.equal(await fs.readFile(path.join(copy, "hello.txt"), "utf8"), "已提交内容");
    assert.equal((await command(git, ["-C", copy, "rev-parse", "HEAD"])).trim(), commit);
    assert.match(await command(git, ["-C", copy, "branch", "--show-current"]), /^agent\//);
    assert.equal((await command(git, ["-C", copy, "remote", "get-url", "origin"])).trim(), "https://github.com/example/repo.git");
    await assert.rejects(fs.stat(path.join(copy, "node_modules")), { code: "ENOENT" });
    await assert.rejects(fs.stat(path.join(copy, ".git/objects/info/alternates")), { code: "ENOENT" });
    await fs.writeFile(path.join(copy, "hello.txt"), "子工作区修改", "utf8");
    assert.equal(await seedWorkspace(options), "");
    assert.equal(await fs.readFile(path.join(copy, "hello.txt"), "utf8"), "子工作区修改");
    assert.equal(await fs.readFile(path.join(repo, "hello.txt"), "utf8"), "父工作区未提交修改");
    await assert.rejects(seedWorkspace({ ...options, sourceId: "other" }), /source_changed/);
    const occupied = path.join(root, "occupied"); await fs.mkdir(occupied); await fs.writeFile(path.join(occupied, "keep"), "keep");
    assert.match(await seedWorkspace({ ...options, work: occupied }), /保留原内容/);
    assert.deepEqual(await fs.readdir(occupied), ["keep"]);
  } finally {
    assert.equal(path.dirname(root), os.tmpdir());
    await fs.rm(root, { recursive: true, force: true });
  }
});
