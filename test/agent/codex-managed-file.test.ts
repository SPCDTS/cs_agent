import { execFileSync } from "node:child_process";
import { constants, promises as fs, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi, type TestContext } from "vitest";
import { renderAgentsMd, writeGlobalAgentsMd, writeManagedFile } from "../../src/agent/codex/runner.js";
import { log } from "../../src/shared/log.js";

const MAX_BYTES = 256 * 1024;
const CONTENT = "受管规则：请勿修改。\n";
const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cs-managed-file-"));
  dirs.push(root);
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace);
  const file = path.join(workspace, "AGENTS.md");
  const outside = path.join(root, "outside.txt");
  await fs.writeFile(outside, "外部文件不能被覆盖", "utf8");
  return { root, workspace, file, outside };
}

function link(target: string, file: string, context: TestContext, type: "file" | "junction" = "file") {
  try { symlinkSync(target, file, type); }
  catch (error) {
    if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") {
      context.skip("Windows 创建符号链接需要权限（symlinkSync EPERM）");
    }
    throw error;
  }
}

async function expectWritten(file: string, content = CONTENT) {
  const stat = await fs.lstat(file);
  expect(stat.isFile()).toBe(true);
  expect(stat.isSymbolicLink()).toBe(false);
  expect(stat.size).toBe(Buffer.byteLength(content, "utf8"));
  expect(await fs.readFile(file, "utf8")).toBe(content);
}

describe("受管 AGENTS.md 安全读写", () => {
  it("首次写入完整中文内容，不留下临时文件", async () => {
    const { file, workspace } = await setup();
    expect(await writeManagedFile(file, CONTENT)).toBe("written");
    await expectWritten(file);
    expect(await fs.readdir(workspace)).toEqual(["AGENTS.md"]);
  });

  it.each([CONTENT, "a".repeat(MAX_BYTES)])("相同内容保留 mtime（%#）", async content => {
    const { file } = await setup();
    await fs.writeFile(file, content, "utf8");
    await fs.utimes(file, 1_000, 1_000);
    const before = await fs.stat(file);
    expect(await writeManagedFile(file, content)).toBe("unchanged");
    expect((await fs.stat(file)).mtimeMs).toBe(before.mtimeMs);
  });

  it("不同内容重写；全局 AGENTS.md 同样修复目录并保留相同内容的 mtime", async () => {
    const { file, workspace, root } = await setup();
    await fs.writeFile(file, "篡改的规则", "utf8");
    expect(await writeManagedFile(file, CONTENT)).toBe("written");
    await expectWritten(file);
    await fs.rm(file);
    await fs.mkdir(file);
    const options = { dataDir: root, workspaceDir: workspace, writableRoots: [workspace] };
    expect(await writeGlobalAgentsMd(workspace, options)).toBe(file);
    await expectWritten(file, renderAgentsMd(options));
    await fs.utimes(file, 1_000, 1_000);
    await writeGlobalAgentsMd(workspace, options);
    expect((await fs.stat(file)).mtimeMs).toBe(1_000_000);
  });

  it.for(["inside", "outside"])("替换指向 %s 文件的链接，目标内容不变", async (location, context) => {
    const { file, workspace, outside } = await setup();
    const target = location === "inside" ? path.join(workspace, "original.md") : outside;
    await fs.writeFile(target, CONTENT, "utf8"); // 即使目标内容相同，也必须替换链接。
    link(target, file, context);
    const warn = vi.spyOn(log, "warn");
    expect(await writeManagedFile(file, CONTENT)).toBe("written");
    await expectWritten(file);
    expect(await fs.readFile(target, "utf8")).toBe(CONTENT);
    expect(warn).toHaveBeenCalledWith("managed file replaced", { file, kind: "symlink" });
  });

  it("目录及其子项被替换为普通文件且记录类型", async () => {
    const { file } = await setup();
    await fs.mkdir(file);
    await fs.writeFile(path.join(file, "nested"), "残留内容", "utf8");
    const open = vi.spyOn(fs, "open"), warn = vi.spyOn(log, "warn");
    expect(await writeManagedFile(file, CONTENT)).toBe("written");
    expect(open.mock.calls.some(([name]) => name === file)).toBe(false);
    expect(warn).toHaveBeenCalledWith("managed file replaced", { file, kind: "directory" });
    await expectWritten(file);
  });

  it("预置 PID 与其他临时文件链接不会被命中或改写目标", async context => {
    const { file, outside } = await setup();
    for (const suffix of [String(process.pid), "00000000-0000-4000-8000-000000000000"]) {
      link(outside, `${file}.${suffix}.tmp`, context);
    }
    expect(await writeManagedFile(file, CONTENT)).toBe("written");
    await expectWritten(file);
    expect(await fs.readFile(outside, "utf8")).toBe("外部文件不能被覆盖");
  });

  it.for(["file", "symlink"])("随机临时名碰撞 %s 时 wx 拒绝覆盖并清理临时路径", async (kind, context) => {
    const { file, outside, workspace } = await setup();
    if (kind === "symlink") {
      const probe = path.join(workspace, "probe");
      link(outside, probe, context);
      await fs.unlink(probe);
    }
    const open = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (name, flags, mode) => {
      if (flags === "wx") {
        expect(String(name)).toMatch(/\.[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\.tmp$/);
        if (kind === "symlink") symlinkSync(outside, String(name), "file");
        else await fs.writeFile(name, "抢占临时路径", "utf8");
      }
      return open(name, flags, mode);
    });
    await expect(writeManagedFile(file, CONTENT)).rejects.toMatchObject({ code: "EEXIST" });
    expect(await fs.readFile(outside, "utf8")).toBe("外部文件不能被覆盖");
    expect(await fs.readdir(workspace)).toEqual([]);
  });

  it("超过 256 KiB 的普通文件不打开读取，直接替换并告警", async () => {
    const { file } = await setup();
    await fs.writeFile(file, Buffer.alloc(MAX_BYTES + 1, 97));
    const open = vi.spyOn(fs, "open"), warn = vi.spyOn(log, "warn");
    expect(await writeManagedFile(file, CONTENT)).toBe("written");
    expect(open.mock.calls.some(([name]) => name === file)).toBe(false);
    expect(warn).toHaveBeenCalledWith("managed file replaced", { file, kind: "oversized" });
    await expectWritten(file);
  });

  it("lstat 后文件增长时 fstat 拒绝读取", async () => {
    const { file } = await setup();
    await fs.writeFile(file, CONTENT, "utf8");
    const open = fs.open.bind(fs), read = vi.fn();
    vi.spyOn(fs, "open").mockImplementation(async (name, flags, mode) => {
      if (name === file) await fs.appendFile(file, Buffer.alloc(MAX_BYTES));
      const handle = await open(name, flags, mode);
      if (name === file) vi.spyOn(handle, "read").mockImplementation(read);
      return handle;
    });
    expect(await writeManagedFile(file, CONTENT)).toBe("written");
    expect(read).not.toHaveBeenCalled();
    await expectWritten(file);
  });

  it("fstat 后文件增长仍只读取原大小加一字节", async () => {
    const { file } = await setup();
    await fs.writeFile(file, CONTENT, "utf8");
    const open = fs.open.bind(fs);
    let readBytes = 0;
    vi.spyOn(fs, "open").mockImplementation(async (name, flags, mode) => {
      const handle = await open(name, flags, mode);
      if (name === file) {
        const stat = handle.stat.bind(handle), read = handle.read.bind(handle);
        vi.spyOn(handle, "stat").mockImplementationOnce(async () => {
          const before = await stat();
          await fs.appendFile(file, Buffer.alloc(MAX_BYTES));
          return before;
        });
        vi.spyOn(handle, "read").mockImplementation(async (...args: Parameters<typeof read>) => {
          const result = await read(...args);
          readBytes += result.bytesRead;
          return result;
        });
      }
      return handle;
    });
    expect(await writeManagedFile(file, CONTENT)).toBe("written");
    expect(readBytes).toBe(Buffer.byteLength(CONTENT) + 1);
    await expectWritten(file);
  });

  it("lstat 后换成链接时不读取链接目标", async context => {
    const { file, workspace, outside } = await setup();
    const replacement = path.join(workspace, "replacement");
    link(outside, replacement, context);
    await fs.writeFile(file, CONTENT, "utf8");
    const open = fs.open.bind(fs), read = vi.fn();
    vi.spyOn(fs, "open").mockImplementation(async (name, flags, mode) => {
      if (name === file) {
        expect(flags).toBe(constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
        await fs.rename(replacement, file);
      }
      const handle = await open(name, flags, mode);
      if (name === file) vi.spyOn(handle, "read").mockImplementation(read);
      return handle;
    });
    expect(await writeManagedFile(file, CONTENT)).toBe("written");
    expect(read).not.toHaveBeenCalled();
    await expectWritten(file);
    expect(await fs.readFile(outside, "utf8")).toBe("外部文件不能被覆盖");
  });

  it.skipIf(process.platform !== "linux")("FIFO 及检查后换成 FIFO 均不阻塞或读取", async () => {
    const { file } = await setup();
    execFileSync("mkfifo", [file]);
    expect(await writeManagedFile(file, CONTENT)).toBe("written");
    const open = fs.open.bind(fs), read = vi.fn();
    vi.spyOn(fs, "open").mockImplementation(async (name, flags, mode) => {
      if (name === file) { await fs.unlink(file); execFileSync("mkfifo", [file]); }
      const handle = await open(name, flags, mode);
      if (name === file) vi.spyOn(handle, "read").mockImplementation(read);
      return handle;
    });
    expect(await writeManagedFile(file, CONTENT)).toBe("written");
    expect(read).not.toHaveBeenCalled();
    await expectWritten(file);
  });

  it.skipIf(process.platform !== "linux")("指向 /dev/zero 的链接被替换而不读取设备", async context => {
    const { file } = await setup();
    link("/dev/zero", file, context);
    const open = vi.spyOn(fs, "open");
    expect(await writeManagedFile(file, CONTENT)).toBe("written");
    expect(open.mock.calls.some(([name]) => name === file)).toBe(false);
    await expectWritten(file);
  });

  it.each(["writeFile", "sync", "rename"] as const)("%s 失败时关闭 fd 并删除临时文件，保留原内容", async method => {
    const { file, workspace } = await setup();
    await fs.writeFile(file, "旧内容", "utf8");
    const failure = new Error("模拟磁盘故障"), open = fs.open.bind(fs);
    let temporaryHandle: Awaited<ReturnType<typeof fs.open>> | undefined;
    if (method === "rename") vi.spyOn(fs, "rename").mockRejectedValueOnce(failure);
    else vi.spyOn(fs, "open").mockImplementation(async (name, flags, mode) => {
      const handle = await open(name, flags, mode);
      if (flags === "wx") {
        temporaryHandle = handle;
        vi.spyOn(handle, method).mockRejectedValueOnce(failure);
      }
      return handle;
    });
    await expect(writeManagedFile(file, CONTENT)).rejects.toThrow(failure);
    if (temporaryHandle) expect(temporaryHandle.fd).toBe(-1);
    expect(await fs.readFile(file, "utf8")).toBe("旧内容");
    expect(await fs.readdir(workspace)).toEqual(["AGENTS.md"]);
  });

  it("父目录在早期检查后成为链接时，rename 前拒绝并清理临时文件", async context => {
    const { root, workspace, file, outside } = await setup();
    const alias = path.join(root, "alias");
    link(workspace, alias, context, "junction");
    const lstat = fs.lstat.bind(fs), rename = vi.spyOn(fs, "rename");
    let checks = 0;
    // 用真实 junction 的 lstat 结果模拟复核时观察到的父目录替换，不移动测试目录。
    vi.spyOn(fs, "lstat").mockImplementation((name, options) => lstat(name === workspace && ++checks === 2 ? alias : name, options));
    await expect(writeManagedFile(file, CONTENT)).rejects.toThrow("父目录必须是真实目录");
    expect(checks).toBe(2);
    expect(rename).not.toHaveBeenCalled();
    expect(await fs.readdir(workspace)).toEqual([]);
    expect(await fs.readFile(outside, "utf8")).toBe("外部文件不能被覆盖");
  });

  it.each(["directory", "wrong-size"])("写后结果为 %s 时明确失败", async kind => {
    const { file, workspace } = await setup();
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementationOnce(async (from, to) => {
      await rename(from, to);
      await fs.unlink(file);
      if (kind === "directory") await fs.mkdir(file);
      else await fs.writeFile(file, "x", "utf8");
    });
    await expect(writeManagedFile(file, CONTENT)).rejects.toThrow("写入后校验失败");
    expect(await fs.readdir(workspace)).toEqual(["AGENTS.md"]);
  });
});
