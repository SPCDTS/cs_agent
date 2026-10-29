import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, realpathSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { createSandboxServer, tailCollector, OUTPUT_CAP } from "../sandbox/server.mjs";

// 控制服务跑在容器里，workerd 测试起不了它；这里用真实 Node 起服务，对临时目录走一遍 HTTP 接口。
const base = realpathSync(mkdtempSync(path.join(tmpdir(), "sandbox-server-")));
const root = path.join(base, "work"), outside = path.join(base, "outside");
const shell = process.platform === "win32" ? path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "usr", "bin", "bash.exe") : "/bin/bash";
let server, origin;

before(async () => {
  mkdirSync(root);
  mkdirSync(outside);
  writeFileSync(path.join(outside, "secret.txt"), "outside");
  // 目录链接在 Windows 上用 junction，不需要管理员权限。
  symlinkSync(outside, path.join(root, "escape"), "junction");
  server = createSandboxServer({ root, shell });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); rmSync(base, { recursive: true, force: true }); });

async function call(method, route, body) {
  const response = await fetch(origin + route, { method, body: typeof body === "string" || body === undefined ? body : JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
const file = (name, extra = "") => `/file?path=${encodeURIComponent(name)}${extra}`;

test("exec 返回 stdout、stderr 与退出码，在指定目录里运行", async () => {
  mkdirSync(path.join(root, "sub"));
  const { body } = await call("POST", "/exec", { cmd: "echo hi; echo oops >&2; pwd; exit 3", cwd: "sub", timeoutMs: 10_000 });
  assert.equal(body.code, 3);
  assert.equal(body.stdout.split("\n")[0], "hi");
  assert.match(body.stdout, /sub\n$/);
  assert.equal(body.stderr, "oops\n");
  assert.deepEqual([body.timedOut, body.truncated], [false, false]);
});

test("exec 超时杀掉命令，code 为 null 并标记 timedOut", async () => {
  const started = Date.now();
  const { body } = await call("POST", "/exec", { cmd: "echo begin; sleep 20", timeoutMs: 500 });
  assert.equal(body.timedOut, true);
  assert.equal(body.code, null);
  assert.equal(body.stdout, "begin\n");
  assert.ok(Date.now() - started < 5_000);
});

test("后台进程不拖住 exec", async () => {
  const started = Date.now();
  const { body } = await call("POST", "/exec", { cmd: "sleep 20 & echo started", timeoutMs: 30_000 });
  assert.equal(body.stdout, "started\n");
  assert.equal(body.code, 0);
  assert.ok(Date.now() - started < 5_000);
});

test("exec 输出超过 64 KiB 只留末尾并标记", async () => {
  const { body } = await call("POST", "/exec", { cmd: "head -c 70000 /dev/zero | tr '\\0' a; echo END", timeoutMs: 10_000 });
  assert.equal(body.truncated, true);
  assert.match(body.stdout, /^\[前 \d+ 字节已省略\]\n/);
  assert.ok(body.stdout.endsWith("aEND\n"));
  assert.ok(Buffer.byteLength(body.stdout.slice(body.stdout.indexOf("\n") + 1)) <= OUTPUT_CAP);
});

test("tailCollector 只保留末尾 cap 字节，不在多字节字符中间开头", () => {
  const collector = tailCollector(8);
  for (const part of ["0123", "4567", "89", "中文"]) collector.push(Buffer.from(part));
  const { text, truncated } = collector.result();
  assert.equal(truncated, true);
  // 末尾 8 字节是 "89" 加两个三字节汉字；省略字节数等于丢掉的 8 个字节。
  assert.equal(text, "[前 8 字节已省略]\n89中文");
  const cut = tailCollector(4);
  cut.push(Buffer.from("ab中文"));
  assert.equal(cut.result().text, "[前 5 字节已省略]\n文");
  const small = tailCollector(8);
  small.push(Buffer.from("ok"));
  assert.deepEqual(small.result(), { text: "ok", truncated: false });
});

test("write 建出父目录，read 按 offset/limit 取行并报告总行数", async () => {
  const content = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");
  assert.deepEqual((await call("PUT", file("out/deep/a.txt"), content)).body, { bytes: Buffer.byteLength(content) });
  assert.equal(readFileSync(path.join(root, "out", "deep", "a.txt"), "utf8"), content);
  assert.deepEqual((await call("GET", file("out/deep/a.txt", "&offset=3&limit=2"))).body, { text: "line 3\nline 4", startLine: 3, endLine: 4, totalLines: 10 });
  assert.deepEqual((await call("GET", file(path.join(root, "out/deep/a.txt")))).body.endLine, 10);
  assert.deepEqual((await call("GET", file("out/deep/a.txt", "&offset=11"))).body, { error: "offset_out_of_range" });
  assert.deepEqual(await call("GET", file("missing.txt")), { status: 404, body: { error: "not_found" } });
});

test("edit 按原文做唯一、不重叠的多处替换", async () => {
  writeFileSync(path.join(root, "e.txt"), "alpha beta gamma beta");
  assert.deepEqual((await call("POST", "/edit", { path: "e.txt", edits: [{ oldText: "alpha", newText: "A" }, { oldText: "gamma", newText: "G" }] })).body, { replaced: 2 });
  assert.equal(readFileSync(path.join(root, "e.txt"), "utf8"), "A beta G beta");
  assert.deepEqual((await call("POST", "/edit", { path: "e.txt", edits: [{ oldText: "beta", newText: "b" }] })).body, { error: "edit_ambiguous" });
  assert.deepEqual((await call("POST", "/edit", { path: "e.txt", edits: [{ oldText: "zeta", newText: "z" }] })).body, { error: "edit_not_found" });
  assert.deepEqual((await call("POST", "/edit", { path: "e.txt", edits: [{ oldText: "A beta", newText: "x" }, { oldText: "beta G", newText: "y" }] })).body, { error: "edit_overlap" });
  assert.equal(readFileSync(path.join(root, "e.txt"), "utf8"), "A beta G beta");
});

test("拒绝 .. 、工作区外的绝对路径与经链接逃逸", async () => {
  const denied = { status: 400, body: { error: "path_denied" } };
  assert.deepEqual(await call("GET", file("../outside/secret.txt")), denied);
  assert.deepEqual(await call("GET", file(path.join(outside, "secret.txt"))), denied);
  assert.deepEqual(await call("GET", file("escape/secret.txt")), denied);
  assert.deepEqual(await call("PUT", file("escape/new.txt"), "x"), denied);
  assert.deepEqual(await call("PUT", file("../planted.txt"), "x"), denied);
  assert.deepEqual(await call("POST", "/edit", { path: "escape/secret.txt", edits: [{ oldText: "outside", newText: "x" }] }), denied);
  assert.deepEqual(await call("POST", "/exec", { cmd: "pwd", cwd: "escape" }), denied);
  assert.deepEqual(await call("GET", "/ls?path=escape"), denied);
  assert.equal(readFileSync(path.join(outside, "secret.txt"), "utf8"), "outside");
});

test("ls 列出工作区目录项", async () => {
  const { body } = await call("GET", "/ls?path=out");
  assert.deepEqual(body, [{ name: "deep", type: "dir", size: 0 }]);
});
