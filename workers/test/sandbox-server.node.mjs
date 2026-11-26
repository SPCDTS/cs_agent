import { test, before, after } from "node:test";
import { createServer } from "node:http";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, realpathSync, existsSync, statSync, chmodSync, readdirSync, lstatSync, promises as fs } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { createSandboxRuntime, resolveInside, tailCollector, OUTPUT_CAP } from "../sandbox/runtime.mjs";

// 固定 CLI 助手在真实 Node 中执行；下载测试只启动本地 HTTP fixture。
const base = realpathSync(mkdtempSync(path.join(tmpdir(), "sandbox-native-")));
const root = path.join(base, "work"), outside = path.join(base, "outside");
const shell = process.platform === "win32" ? path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "usr", "bin", "bash.exe") : "/bin/bash";
let runtime;
before(() => {
  mkdirSync(root); mkdirSync(outside); writeFileSync(path.join(outside, "secret.txt"), "outside");
  symlinkSync(outside, path.join(root, "escape"), "junction");
  runtime = createSandboxRuntime({ root, shell, env: process.platform === "win32" ? { PATH: "/usr/bin:/bin" } : {} });
});
after(() => { rmSync(base, { recursive: true, force: true }); });
test("native CLI 返回 stdout、stderr、退出码和 cwd", async () => {
  mkdirSync(path.join(root, "sub"));
  const result = await runtime.exec({ command: "echo hi; echo oops >&2; pwd; exit 3", cwd: "sub", timeoutMs: 10000 });
  assert.equal(result.code, 3); assert.equal(result.stdout.split("\n")[0], "hi");
  assert.match(result.stdout, /sub\n$/); assert.equal(result.stderr, "oops\n");
  assert.deepEqual([result.timedOut, result.truncated], [false, false]);
});
test("native CLI 超时返回 null 退出码", async () => {
  const started = Date.now();
  const result = await runtime.exec({ command: "echo begin; sleep 20", timeoutMs: 300 });
  assert.equal(result.timedOut, true); assert.equal(result.code, null); assert.equal(result.stdout, "begin\n");
  assert.ok(Date.now() - started < 5000);
});
test("后台进程不拖住 native CLI", async () => {
  const started = Date.now();
  const result = await runtime.exec({ command: "sleep 20 & echo started", timeoutMs: 30000 });
  assert.equal(result.stdout, "started\n"); assert.equal(result.code, 0); assert.ok(Date.now() - started < 5000);
});
test("超时和正常退出都终止 fork 的 JS 后台子进程，封存后不再写文件", { skip: process.platform === "win32" }, async () => {
  const childSource = "setTimeout(()=>require('node:fs').writeFileSync(process.argv[1],'late'),700);setInterval(()=>{},1000)";
  const parentSource = "require('node:child_process').spawn(process.execPath,['-e',process.argv[1],process.argv[2]],{stdio:'ignore'});setInterval(()=>{},1000)";
  const quote = text => "'" + text.replaceAll("'", "'\\''") + "'";
  const marker = path.join(root, "late.txt");
  const command = `${quote(process.execPath)} -e ${quote(parentSource)} ${quote(childSource)} ${quote(marker)}`;
  assert.equal((await runtime.exec({ command, timeoutMs: 200 })).timedOut, true);
  await new Promise(resolve => setTimeout(resolve, 900)); assert.equal(existsSync(marker), false);
  const normal = `${quote(process.execPath)} -e ${quote(childSource)} ${quote(marker)} & echo done`;
  assert.equal((await runtime.exec({ command: normal, timeoutMs: 5000 })).code, 0);
  await new Promise(resolve => setTimeout(resolve, 900)); assert.equal(existsSync(marker), false);
});
test("native CLI 输出超过 64 KiB 只保留尾部", async () => {
  const result = await runtime.exec({ command: "head -c 70000 /dev/zero | tr '\\0' a; echo END", timeoutMs: 10000 });
  assert.equal(result.truncated, true); assert.match(result.stdout, /^\[前 \d+ 字节已省略\]\n/);
  assert.ok(result.stdout.endsWith("aEND\n")); assert.ok(Buffer.byteLength(result.stdout.slice(result.stdout.indexOf("\n") + 1)) <= OUTPUT_CAP);
});
test("目录备份只暂存追踪文件，保留空目录，文件变更时拒绝生成旧版本备份", async t => {
  const work = mkdtempSync(path.join(base, "backup-source-"));
  const user = { uid: 1000, gid: 1000 }, privileged = process.getuid?.() === 0;
  const chown = privileged ? t.mock.method(fs, "chown") : t.mock.method(fs, "chown", async () => {});
  const host = createSandboxRuntime({ root: work, user });
  mkdirSync(path.join(work, "empty", "child"), { recursive: true });
  mkdirSync(path.join(work, "a", "b"), { recursive: true });
  mkdirSync(path.join(work, "node_modules"));
  writeFileSync(path.join(work, "node_modules", "untracked"), "cache");
  writeFileSync(path.join(work, "a", "b", "report"), Buffer.from([0, 255, 1]));
  const snapshot = await host.snapshot();
  snapshot.directories = ["empty/child"];
  const stage = await host.stageBackup(snapshot);
  try {
    assert.deepEqual(readFileSync(path.join(stage, "a", "b", "report")), Buffer.from([0, 255, 1]));
    assert.equal(existsSync(path.join(stage, "empty", "child")), true);
    const owned = new Set(chown.mock.calls.filter(({ arguments: [, uid, gid] }) => uid === user.uid && gid === user.gid).map(({ arguments: [file] }) => file));
    for (const item of ["", "empty", "empty/child", "a", "a/b", "a/b/report"]) {
      const file = path.join(stage, item);
      assert.ok(owned.has(file), item);
      if (privileged) assert.deepEqual([statSync(file).uid, statSync(file).gid], [user.uid, user.gid]);
    }
    assert.equal(existsSync(path.join(stage, "node_modules")), false);
    writeFileSync(path.join(work, "a", "b", "report"), "changed");
    await assert.rejects(host.stageBackup(snapshot), /workspace_conflict/);
  } finally { await host.discardBackup(stage); }
  assert.equal(existsSync(stage), false);
});
test("tailCollector 保留中文字符边界", () => {
  const collector = tailCollector(8); for (const part of ["0123", "4567", "89", "中文"]) collector.push(Buffer.from(part));
  assert.deepEqual(collector.result(), { text: "[前 8 字节已省略]\n89中文", truncated: true });
  const cut = tailCollector(4); cut.push(Buffer.from("ab中文")); assert.equal(cut.result().text, "[前 5 字节已省略]\n文");
});
test("realpath 拒绝工作区外路径、链接逃逸和经悬空链接写入", async () => {
  for (const input of ["../outside/secret.txt", path.join(outside, "secret.txt"), "escape/secret.txt", "escape/new.txt"])
    await assert.rejects(resolveInside(root, input), /path_denied/);
  await assert.rejects(runtime.exec({ command: "pwd", cwd: "escape" }), /path_denied/);
  assert.equal(readFileSync(path.join(outside, "secret.txt"), "utf8"), "outside");
});

test("模型脚本经 native CLI 请求网页、解析相对图片地址并保存真实二进制产物", async () => {
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aH1sAAAAASUVORK5CYII=", "base64");
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    if (request.url === "/page") { response.setHeader("Content-Type", "text/html"); response.end('<img src="/jersey.png">'); }
    else if (request.url === "/jersey.png") { response.setHeader("Content-Type", "image/png"); response.end(bytes); }
    else { response.statusCode = 404; response.end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.equal(typeof address, "object");
    const source = `import { mkdir, writeFile } from "node:fs/promises";
const page = await fetch("http://127.0.0.1:${address.port}/page");
if (!page.ok) throw Error(String(page.status));
const relative = /<img src="([^"]+)"/.exec(await page.text())[1];
const image = await fetch(new URL(relative, page.url));
if (!image.ok) throw Error(String(image.status));
await mkdir("out", {recursive:true});
await writeFile("out/jersey.png", new Uint8Array(await image.arrayBuffer()));`;
    writeFileSync(path.join(root, "download.mjs"), source, "utf8");
    const quote = text => "'" + text.replaceAll("'", "'\\''") + "'";
    const result = await runtime.exec({ command: `${quote(process.execPath.replaceAll("\\", "/"))} download.mjs`, timeoutMs: 10000 });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.timedOut, false);
    assert.deepEqual(requests, ["/page", "/jersey.png"]);
    assert.deepEqual(readFileSync(path.join(root, "out", "jersey.png")), bytes);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test("受控 Skill 运行时：只读物化代码、shell:false 防注入、状态写回与 /work/out 软链拦截", async () => {
  const skillBase = path.join(base, "skill-env");
  const skillRoot = path.join(skillBase, "work");
  const skillCodeRoot = path.join(skillBase, "opt-skill");
  const skillDepsRoot = path.join(skillBase, "opt-skill-deps");
  const cacheRoot = path.join(skillBase, "cache");
  mkdirSync(skillRoot, { recursive: true });
  const envPath = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
  const skillRuntime = createSandboxRuntime({
    root: skillRoot,
    shell,
    env: { PATH: envPath },
    skillCodeRoot,
    skillDepsRoot,
    cacheRoot,
  });

  const script = [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const input = JSON.parse(fs.readFileSync(0, 'utf8'));",
    "const stateFile = path.join(process.env.SKILL_STATE_DIR, 'session.json');",
    "const prev = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { count: 0 };",
    "prev.count += 1;",
    "prev.lastArg = input.q;",
    "fs.writeFileSync(stateFile, JSON.stringify(prev));",
    "fs.writeFileSync(path.join(process.env.SKILL_OUT_DIR, 'result.json'), JSON.stringify({ count: prev.count, q: input.q }));",
    "if (input.symlink) fs.symlinkSync(stateFile, path.join(process.env.SKILL_OUT_DIR, 'leak.txt'));",
    "console.log('COUNT=' + prev.count);",
  ].join("\n");

  const makeWritable = target => {
    if (!existsSync(target)) return;
    const stat = lstatSync(target);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      chmodSync(target, 0o755);
      for (const name of readdirSync(target)) makeWritable(path.join(target, name));
    } else {
      chmodSync(target, 0o644);
    }
  };

  try {
    await skillRuntime.materializeSkill({
      revision: "rev-1",
      files: {
        "scripts/run.js": script,
        "runner.json": "{}",
      },
    });
    const first = await skillRuntime.execSkill({
      argv: ["node", "scripts/run.js"],
      stdin: JSON.stringify({ q: "$(echo INJECTED); touch /tmp/bad" }),
      timeoutMs: 10_000,
    });
    assert.equal(first.code, 0, first.stderr);
    assert.equal(first.stdout.trim(), "COUNT=1");
    assert.equal(first.outputs.length, 1);
    assert.equal(first.outputs[0].path, "result.json");
    const snap = await skillRuntime.skillStateSnapshot();
    assert.ok(snap.files.some(f => f.path === "session.json"));
    assert.ok(!snap.files.some(f => f.path === "result.json"));

    const bashRes = await skillRuntime.execSkillBash({
      command: "cat \"$SKILL_STATE_DIR/session.json\"",
      timeoutMs: 10_000,
    });
    assert.equal(bashRes.code, 0);
    assert.equal(JSON.parse(bashRes.stdout).lastArg, "$(echo INJECTED); touch /tmp/bad");

    await assert.rejects(
      skillRuntime.execSkill({
        argv: ["node", "scripts/run.js"],
        stdin: JSON.stringify({ q: "leak", symlink: true }),
        timeoutMs: 10_000,
      }),
      /path_denied/,
    );
    await skillRuntime.clearSkillOut();

    // 验证 npm ci 暂存目录同父级放置、缓存目录可写与 ESM import 解析
    const fakeBin = path.join(skillBase, "fake-bin");
    mkdirSync(fakeBin, { recursive: true });
    const fakeNpm = path.join(fakeBin, "npm");
    writeFileSync(
      fakeNpm,
      [
        "#!/bin/sh",
        "set -e",
        "mkdir -p node_modules/esm-demo",
        "printf '{\"name\":\"esm-demo\",\"type\":\"module\",\"exports\":\"./index.mjs\"}' > node_modules/esm-demo/package.json",
        "printf 'export const msg = \"esm-ok\";\\n' > node_modules/esm-demo/index.mjs",
        "printf 'ok' > \"$npm_config_cache/cache-hit\"",
      ].join("\n"),
      { mode: 0o755 },
    );
    const depsRuntime = createSandboxRuntime({
      root: skillRoot,
      shell,
      env: { PATH: `${fakeBin}:${envPath}` },
      skillCodeRoot,
      skillDepsRoot,
      cacheRoot,
    });
    await depsRuntime.materializeSkill({
      revision: "rev-esm-1",
      installNpmDeps: true,
      depsHash: "deps-h1",
      files: {
        "runner.json": "{}",
        "package.json": "{\"name\":\"demo\",\"type\":\"module\"}",
        "package-lock.json": "{\"lockfileVersion\":3}",
        "scripts/esm-run.mjs": "import { msg } from 'esm-demo'; console.log(msg);\n",
      },
    });
    const esmRes = await depsRuntime.execSkill({
      argv: ["node", "scripts/esm-run.mjs"],
      stdin: "{}",
      timeoutMs: 10_000,
    });
    assert.equal(esmRes.code, 0, esmRes.stderr);
    assert.equal(esmRes.stdout.trim(), "esm-ok");
  } finally {
    makeWritable(skillBase);
    rmSync(skillBase, { recursive: true, force: true });
  }
});
