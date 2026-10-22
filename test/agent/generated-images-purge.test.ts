import { existsSync, mkdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { purgeGeneratedImages } from "../../src/agent/codex/generated-images.js";
import { tmp } from "./helpers.js";

const DAY_MS = 86_400_000, MB = 1024 * 1024, NOW = Date.UTC(2026, 9, 19);
const ZERO = { removed: 0, bytes: 0, dirs: 0 };
const dirs: string[] = [];
const temp = () => { const dir = tmp("cs-generated-images-purge-"); dirs.push(dir); return dir; };
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

function fixture() {
  const home = temp(), root = path.join(home, "generated_images");
  mkdirSync(root);
  return { home, root };
}

function file(root: string, name: string, mtime = NOW, size = 7): string {
  const target = path.join(root, name);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, Buffer.alloc(size));
  utimesSync(target, mtime / 1000, mtime / 1000);
  return target;
}

describe("Codex 内置生图输出清理", () => {
  it("按天递归删除，保留截止时间边界、近期文件和根外文件", async () => {
    const { home, root } = fixture(), cutoff = NOW - 7 * DAY_MS;
    const files = [file(root, "expired/exec-old.png", cutoff - 1000), file(root, "thread/turn/old.png", cutoff - 1000),
      file(root, "thread/boundary.png", cutoff), file(root, "thread/recent.png"), file(home, "outside.png", 0)];
    expect(await purgeGeneratedImages(home, 7, NOW, 0)).toEqual({ removed: 2, bytes: 14, dirs: 2 });
    expect(files.map(target => existsSync(target))).toEqual([false, false, true, true, true]);
    expect(existsSync(root)).toBe(true);
    expect(await purgeGeneratedImages(home, 7, NOW, 0)).toEqual(ZERO);
  });

  it("先删除过期文件，再跨线程按 mtime 从旧到新删到恰好达标", async () => {
    const { home, root } = fixture();
    const files = [file(root, "expired/exec.png", NOW - 8 * DAY_MS, 100),
      file(root, "z/oldest.png", NOW - 3000, MB / 2), file(root, "a/middle.png", NOW - 2000, MB / 2),
      file(root, "latest/exec.png", NOW, MB)];
    expect(await purgeGeneratedImages(home, 7, NOW, 1)).toEqual({ removed: 3, bytes: MB + 100, dirs: 3 });
    expect(files.map(target => existsSync(target))).toEqual([false, false, false, true]);
    expect(await purgeGeneratedImages(home, 7, NOW, 1)).toEqual(ZERO);
  });

  it("过期清理后总量已达标，不额外删除", async () => {
    const { home, root } = fixture();
    file(root, "old/exec.png", 0, MB);
    const recent = file(root, "recent/exec.png", NOW, MB);
    expect(await purgeGeneratedImages(home, 7, NOW, 1)).toEqual({ removed: 1, bytes: MB, dirs: 1 });
    expect(existsSync(recent)).toBe(true);
  });

  it("总量上限为 0 时只按天清理，保留超出容量的近期文件", async () => {
    const { home, root } = fixture();
    file(root, "thread/old.png", 0);
    const recent = file(root, "thread/recent.png", NOW, 2 * MB);
    expect(await purgeGeneratedImages(home, 7, NOW, 0)).toEqual({ removed: 1, bytes: 7, dirs: 0 });
    expect(existsSync(recent)).toBe(true);
  });

  it("保留期为 0 时只按容量清理，同 mtime 按路径稳定排序", async () => {
    const { home, root } = fixture();
    const first = file(root, "a/exec.png", 0, MB), last = file(root, "z/exec.png", 0, MB);
    expect(await purgeGeneratedImages(home, 0, NOW, 1)).toEqual({ removed: 1, bytes: MB, dirs: 1 });
    expect(existsSync(first)).toBe(false);
    expect(existsSync(last)).toBe(true);
  });

  it("两个限制都为 0 时不删除文件或空目录", async () => {
    const { home, root } = fixture();
    const old = file(root, "thread/exec.png", 0, 2 * MB), empty = path.join(root, "empty");
    mkdirSync(empty);
    expect(await purgeGeneratedImages(home, 0, NOW, 0)).toEqual(ZERO);
    expect(existsSync(old)).toBe(true);
    expect(existsSync(empty)).toBe(true);
  });

  it("由内向外移除空子目录，保留根和非空目录", async () => {
    const { home, root } = fixture();
    mkdirSync(path.join(root, "empty", "nested"), { recursive: true });
    file(root, "expired/exec.png", 0);
    const recent = file(root, "nonempty/exec.png");
    expect(await purgeGeneratedImages(home, 7, NOW)).toEqual({ removed: 1, bytes: 7, dirs: 3 });
    expect(await fs.readdir(root)).toEqual(["nonempty"]);
    expect(existsSync(recent)).toBe(true);
    expect(await purgeGeneratedImages(home, 7, NOW)).toEqual(ZERO);
  });

  it("目录链接不遍历、不计入容量、不删除，含链接的线程目录保留", async () => {
    const { home, root } = fixture(), outside = temp();
    const external = file(outside, "old.png", 0, 2 * MB), local = file(root, "thread/local.png", NOW, MB);
    const link = path.join(root, "thread", "linked");
    symlinkSync(outside, link, "junction");
    expect(await purgeGeneratedImages(home, 7, NOW, 1)).toEqual(ZERO);
    expect(existsSync(local)).toBe(true);
    expect(existsSync(external)).toBe(true);
    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
  });

  it("文件符号链接及其根外目标保持原样", async context => {
    const { home, root } = fixture(), outside = temp();
    const external = file(outside, "old.png", 0, 2 * MB), link = path.join(root, "linked.png");
    try { symlinkSync(external, link, "file"); }
    catch (error) {
      if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") {
        context.skip(true, "Windows 当前用户无创建文件符号链接权限"); return;
      }
      throw error;
    }
    expect(await purgeGeneratedImages(home, 7, NOW, 1)).toEqual(ZERO);
    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
    expect(readFileSync(external).length).toBe(2 * MB);
  });

  it("根目录为链接时不动链接或目标目录中的内容", async () => {
    const home = temp(), outside = temp(), root = path.join(home, "generated_images");
    const external = file(outside, "thread/old.png", 0, 2 * MB);
    mkdirSync(path.join(outside, "empty"));
    symlinkSync(outside, root, "junction");
    expect(await purgeGeneratedImages(home, 7, NOW, 1)).toEqual(ZERO);
    expect((await fs.lstat(root)).isSymbolicLink()).toBe(true);
    expect(existsSync(external)).toBe(true);
    expect(existsSync(path.join(outside, "empty"))).toBe(true);
  });

  it("根不存在或不是目录时返回零", async () => {
    const home = temp();
    expect(await purgeGeneratedImages(home, 7, NOW)).toEqual(ZERO);
    writeFileSync(path.join(home, "generated_images"), "regular file");
    expect(await purgeGeneratedImages(home, 7, NOW)).toEqual(ZERO);
  });

  it("realpath 二次检查拒绝解析到同名前缀的根外目录", async () => {
    const { home, root } = fixture(), outside = path.join(home, "generated_images-other");
    const local = file(root, "thread/old.png", 0), external = file(outside, "old.png", 0);
    const realpath = fs.realpath.bind(fs);
    vi.spyOn(fs, "realpath").mockImplementation(async target =>
      String(target) === path.join(root, "thread") ? outside : realpath(target));
    expect(await purgeGeneratedImages(home, 7, NOW, 1)).toEqual(ZERO);
    expect(existsSync(local)).toBe(true);
    expect(existsSync(external)).toBe(true);
  });

  it("容量删除前重新检查路径，线程换为根外链接后不删除目标内容", async () => {
    const { home, root } = fixture(), outside = temp(), thread = path.join(root, "thread");
    const local = file(root, "thread/exec.png", NOW, 2 * MB), external = file(outside, "exec.png", 0, 2 * MB);
    const lstat = fs.lstat.bind(fs);
    let checks = 0;
    vi.spyOn(fs, "lstat").mockImplementation(async target => {
      if (String(target) === local && ++checks === 2) {
        await fs.rename(thread, path.join(home, "moved-thread"));
        symlinkSync(outside, thread, "junction");
      }
      return lstat(target);
    });
    expect(await purgeGeneratedImages(home, 7, NOW, 1)).toEqual(ZERO);
    expect(existsSync(external)).toBe(true);
    expect((await lstat(thread)).isSymbolicLink()).toBe(true);
  });

  it("清理期间文件已消失则继续，目录已有新文件则保留", async () => {
    const { home, root } = fixture(), thread = path.join(root, "thread");
    const old = file(root, "thread/old.png", 0), vanished = file(root, "vanished/exec.png", 0);
    const unlink = fs.unlink.bind(fs), rmdir = fs.rmdir.bind(fs);
    vi.spyOn(fs, "unlink").mockImplementation(async target => {
      if (String(target) === vanished) await unlink(target);
      return unlink(target);
    });
    vi.spyOn(fs, "rmdir").mockImplementation(async target => {
      if (String(target) === thread) file(root, "thread/new.png");
      return rmdir(target);
    });
    expect(await purgeGeneratedImages(home, 7, NOW, 0)).toEqual({ removed: 1, bytes: 7, dirs: 1 });
    expect(existsSync(old)).toBe(false);
    expect(existsSync(path.join(thread, "new.png"))).toBe(true);
  });

  it("权限错误向调用方抛出，不伪装成清理成功", async () => {
    const { home, root } = fixture();
    const old = file(root, "thread/old.png", 0), error = Object.assign(new Error("denied"), { code: "EACCES" });
    vi.spyOn(fs, "unlink").mockRejectedValue(error);
    await expect(purgeGeneratedImages(home, 7, NOW, 0)).rejects.toBe(error);
    expect(existsSync(old)).toBe(true);
  });

  it.each([-1, 1.5, NaN])("拒绝非法保留期 %s", async days => {
    await expect(purgeGeneratedImages(temp(), days, NOW, 0)).rejects.toThrow(/保留期/);
  });

  it.each([NaN])("两个限制关闭时仍拒绝非法时间 %s", async now => {
    await expect(purgeGeneratedImages(temp(), 0, now, 0)).rejects.toThrow(/保留期/);
  });

  it.each([-1, NaN, Math.floor(Number.MAX_SAFE_INTEGER / MB) + 1])(
    "拒绝非法或字节数不安全的容量 %s", async maxMb => {
      await expect(purgeGeneratedImages(temp(), 0, NOW, maxMb)).rejects.toThrow(/总量上限/);
    });
});
