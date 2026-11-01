import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, realpathSync, existsSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { createSandboxRuntime, resolveInside, tailCollector, OUTPUT_CAP } from "../sandbox/runtime.mjs";

// 固定 CLI 助手在真实 Node 中执行；不创建 HTTP 服务。
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
