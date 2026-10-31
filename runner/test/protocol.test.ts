import { test } from "node:test";
import assert from "node:assert/strict";
import { relativePath, validateSnapshot, ephemeralPath, mismatch, parseFrame, ServerFrameSchema, type Descriptor } from "../src/protocol.ts";
const descriptor: Descriptor = { name: "测试机", provider: "windows-wsb", os: "windows", arch: "x64", shells: ["powershell"], tools: [{ name: "node", version: "v24.15.0" }],
  taskTypes: ["shell.exec", "node.test"], memoryMiB: 4096, maxConcurrent: 1, maxTimeoutMs: 1200000, workspaceProtocol: "r2-source-v1", cache: { npm: true, git: false } };
test("Windows 路径拒绝逃逸、ADS、设备名和大小写碰撞", () => {
  for (const path of ["../x", "/work/../x", "C:/x", "\\\\host\\share", "a:stream", "CON", "a/NUL.txt", "a.", "a ", "a//b", "a\\b", "a?b"])
    assert.throws(() => relativePath(path), /path_denied/, path);
  assert.equal(relativePath("/work/目录/a.txt"), "目录/a.txt");
  assert.equal(relativePath("/work", true), "");
  assert.equal(ephemeralPath("workers/Node_Modules/a.js"), true);
  assert.throws(() => validateSnapshot({ files: [], directories: ["a", "A"], totalBytes: 0 }), /path_denied/);
  assert.throws(() => validateSnapshot({ files: [{ path: "a", sha256: "0".repeat(64), bytes: 1, mime: "text/plain", mode: 420 }], directories: ["a/b"], totalBytes: 1 }), /path_denied/);
  assert.throws(() => validateSnapshot({ files: [], directories: [".git"], totalBytes: 0 }), /path_denied/);
});
test("能力匹配不把缓存、设备名称当成权限", () => {
  assert.deepEqual(mismatch(descriptor, "node.test", { os: "windows", shell: "powershell", memoryMiB: 4096, tools: [{ name: "node", version: "v24.15.0" }] }), []);
  assert.deepEqual(mismatch(descriptor, "gpu.exec", { os: "linux", shell: "bash", memoryMiB: 8192, tools: [{ name: "node", version: "v22" }] }), ["task_type", "os", "shell", "memory", "tool:node"]);
  assert.throws(() => parseFrame(ServerFrameSchema, JSON.stringify({ kind: "execute", jobId: "../x" })), /invalid_request/);
  assert.throws(() => parseFrame(ServerFrameSchema, " ".repeat(128 * 1024 + 1)), /frame_too_large/);
});
