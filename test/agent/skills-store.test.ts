import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { zipSync, unzipSync, strToU8 } from "fflate";
import { SkillsStore } from "../../src/agent/skills-store.js";
import { SkillsLoader } from "../../src/agent/pi-tools/skills.js";
import { log } from "../../src/shared/log.js";
import { tmp } from "./helpers.js";

const md = (name = "hello", description = "中文说明", body = "技能正文") => `---\nname: ${name}\ndescription: ${description}\n---\n${body}`;
const zip = (files: Record<string, string | Uint8Array>) => zipSync(Object.fromEntries(Object.entries(files).map(([name, data]) => [name, typeof data === "string" ? strToU8(data) : data])));
let dir: string, root: string, loader: SkillsLoader, store: SkillsStore;
const put = async (file: string, content = "") => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content, "utf8"); };
beforeEach(() => {
  root = tmp("skills-store-"); dir = path.join(root, "skills"); loader = new SkillsLoader({ dir }); store = new SkillsStore({ dir, loader });
  vi.spyOn(log, "warn").mockImplementation(() => {});
});
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });

describe("SkillsStore", () => {
  it.each(["../escape", "UPPER", "", "two--words", "a/b", "a\\b", "-start", "end-", "a".repeat(65)])("所有管理入口拒绝非法名称 %j", async name => {
    for (const action of [() => store.files(name), () => store.readSkillMd(name), () => store.exportZip(name), () => store.remove(name), () => store.importSkillMd(md(name), { overwrite: true })]) {
      await expect(action()).rejects.toMatchObject({ status: 400 });
    }
  });

  it("多技能与多层包装导入，缺 description、目录名不符和缺 SKILL.md 分别跳过", async () => {
    const result = await store.importZip(zip({
      "bundle/hello/SKILL.md": md(), "bundle/hello/assets/a.txt": "资源", "second/SKILL.md": md("second"),
      "bad/SKILL.md": "---\nname: bad\n---\n正文", "wrong/SKILL.md": md("different"), "absent/a.txt": "资源",
      "__MACOSX/metadata": "忽略", "second/.DS_Store": "忽略",
    }), { overwrite: false });
    expect(result.imported.sort()).toEqual(["hello", "second"]);
    expect(result.skipped).toEqual(expect.arrayContaining([
      { path: "bad", reason: "description is required" }, { path: "wrong", reason: "目录名必须等于 name" }, { path: "absent", reason: "缺少 SKILL.md" },
    ]));
    expect((await store.list()).map(s => s.name)).toEqual(["hello", "second"]);
    expect(await fs.readFile(path.join(dir, "hello/assets/a.txt"), "utf8")).toBe("资源");
    expect(await fs.readdir(dir)).toEqual(["hello", "second"]);
  });

  it("根下 SKILL.md 与资源按 frontmatter name 安装，单文件保留原文", async () => {
    const text = md().replaceAll("\n", "\r\n");
    expect(await store.importZip(zip({ "SKILL.md": text, "资源.txt": "资源", "empty/": "" }), { overwrite: false })).toEqual({ imported: ["hello"], skipped: [] });
    expect(await store.readSkillMd("hello")).toBe(text);
    expect(await store.importSkillMd(md("single"), { overwrite: false })).toEqual({ name: "single" });
    expect(await store.files("hello")).toEqual([{ path: "SKILL.md", size: Buffer.byteLength(text) }, { path: "资源.txt", size: 6 }]);
    expect((await store.list())[0]).toMatchObject({ name: "hello", description: "中文说明", files: 2, bytes: Buffer.byteLength(text) + 6, diagnostics: [], hidden: false, mtime: expect.any(Number) });
  });

  it.each(["../evil", "/evil", "C:/evil", "hello/../evil", "hello\\evil", "hello/a:stream", "hello/./x", "hello//x", "hello/NUL", "hello/a."])("ZIP 路径 %j 整包拒绝且不落盘", async entry => {
    await expect(store.importZip(zip({ "hello/SKILL.md": md(), [entry]: "bad" }), { overwrite: true })).rejects.toMatchObject({ status: 400 });
    expect(await store.list()).toEqual([]);
  });

  it("ZIP 重复大小写路径与文件目录冲突在落盘前拒绝", async () => {
    for (const files of <Record<string, string>[]>[{ "hello/a": "x", "hello/A": "y" }, { "hello/a": "x", "hello/a/b": "y" }]) {
      await expect(store.importZip(zip({ "hello/SKILL.md": md(), ...files }), { overwrite: false })).rejects.toMatchObject({ status: 400 });
    }
    expect(await store.list()).toEqual([]);
  });

  it("链接属性条目按普通文件保存，不创建或跟随链接", async () => {
    const bytes = zipSync({ "hello/SKILL.md": strToU8(md()), "hello/link": [strToU8("../../outside"), { os: 3, attrs: 0o120777 << 16 }] });
    await store.importZip(bytes, { overwrite: false });
    const st = await fs.lstat(path.join(dir, "hello/link"));
    expect(st.isFile()).toBe(true); expect(st.isSymbolicLink()).toBe(false);
    expect(await fs.readFile(path.join(dir, "hello/link"), "utf8")).toBe("../../outside");
  });

  it("解压前拒绝超大文件、总量及超条目数，损坏 ZIP 返回 400", async () => {
    const limited = (limits: { maxFileBytes?: number; maxZipBytes?: number; maxEntries?: number }) => new SkillsStore({ dir, loader, limits });
    const bomb = zip({ "hello/SKILL.md": md(), "hello/large": "x".repeat(2000) });
    await expect(limited({ maxFileBytes: 1000 }).importZip(bomb, { overwrite: false })).rejects.toMatchObject({ status: 413 });
    await expect(limited({ maxZipBytes: 1500 }).importZip(bomb, { overwrite: false })).rejects.toMatchObject({ status: 413 });
    await expect(limited({ maxEntries: 1 }).importZip(bomb, { overwrite: false })).rejects.toMatchObject({ status: 413 });
    await expect(store.importZip(Buffer.from("PK\x03\x04bad"), { overwrite: false })).rejects.toMatchObject({ status: 400 });
    await expect(store.importZip(Buffer.from("bad"), { overwrite: false })).rejects.toMatchObject({ status: 400 });
    expect(await store.list()).toEqual([]);
  });

  it("SKILL.md 限制 256 KiB、严格 UTF-8 和完整 frontmatter", async () => {
    await expect(store.importSkillMd(md("hello", "x", "x".repeat(256 * 1024)), { overwrite: false })).rejects.toMatchObject({ status: 413 });
    await expect(store.importSkillMd("正文", { overwrite: false })).rejects.toMatchObject({ status: 400 });
    await expect(store.importSkillMd(md("hello", "x".repeat(1025)), { overwrite: false })).rejects.toMatchObject({ status: 400 });
    const result = await store.importZip(zip({ "hello/SKILL.md": new Uint8Array([255]) }), { overwrite: false });
    expect(result.skipped[0].reason).toContain("UTF-8");
    await put(path.join(dir, "hello/SKILL.md"), "x".repeat(256 * 1024 + 1));
    await expect(store.readSkillMd("hello")).rejects.toMatchObject({ status: 413 });
    await fs.writeFile(path.join(dir, "hello/SKILL.md"), new Uint8Array([255]));
    await expect(store.readSkillMd("hello")).rejects.toMatchObject({ status: 400 });
  });

  it("不覆盖返回原因，覆盖整体替换并清除临时目录，连续请求串行", async () => {
    await store.importZip(zip({ "hello/SKILL.md": md(), "hello/old": "old" }), { overwrite: false });
    await expect(store.importSkillMd(md(), { overwrite: false })).rejects.toMatchObject({ status: 409 });
    expect((await store.importZip(zip({ "hello/SKILL.md": md("hello", "新版") }), { overwrite: false })).skipped[0].reason).toContain("已存在");
    await Promise.all([store.importSkillMd(md("hello", "新版"), { overwrite: true }), store.importSkillMd(md("hello", "最终版"), { overwrite: true })]);
    expect(await store.readSkillMd("hello")).toContain("最终版");
    expect(await fs.readdir(path.join(dir, "hello"))).toEqual(["SKILL.md"]);
    expect(await fs.readdir(dir)).toEqual(["hello"]);
  });

  it("覆盖发布失败恢复旧目录，不留下可见半成品", async () => {
    await store.importSkillMd(md(), { overwrite: false });
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (path.basename(String(from)).startsWith(".tmp-") && !path.basename(String(from)).startsWith(".tmp-old-")) throw new Error("模拟发布失败");
      return rename(from, to);
    });
    await expect(store.importSkillMd(md("hello", "新版"), { overwrite: true })).rejects.toThrow("模拟发布失败");
    expect(await store.readSkillMd("hello")).toBe(md());
    expect(await fs.readdir(dir)).toEqual(["hello"]);
  });

  it("列表包含诊断、hidden 与缺失文件，跳过链接和所有中间态", async () => {
    await put(path.join(dir, "hidden/SKILL.md"), md("hidden").replace("---\n技能正文", "disable-model-invocation: true\n---\n正文"));
    await put(path.join(dir, "invalid/SKILL.md"), "---\nname: invalid\n---");
    await put(path.join(dir, "absent/a"));
    await put(path.join(dir, ".tmp-stage/SKILL.md"), md("stage"));
    const outside = path.join(root, "outside"); await put(path.join(outside, "SKILL.md"), md("outside"));
    await fs.symlink(outside, path.join(dir, "linked"), "junction");
    const entries = await store.list();
    expect(entries.map(s => s.name)).toEqual(["absent", "hidden", "invalid"]);
    expect(entries[0].diagnostics).toContain("缺少 SKILL.md");
    expect(entries[1].hidden).toBe(true); expect(entries[2].diagnostics).toContain("description is required");
    expect((await loader.load()).skills.map(s => s.name)).toEqual(["hidden"]);
  });

  it("导出保留顶层路径、二进制和空目录，跳过嵌套链接与临时目录", async () => {
    const binary = new Uint8Array([0, 255, 1, 2]);
    await store.importZip(zip({ "hello/SKILL.md": md(), "hello/data.bin": binary, "hello/empty/": "" }), { overwrite: false });
    await put(path.join(dir, "hello/.tmp-work/secret"), "不可导出");
    const outside = path.join(root, "outside"); await put(path.join(outside, "secret"), "不可导出");
    await fs.symlink(outside, path.join(dir, "hello/link"), "junction");
    const exported = unzipSync(await store.exportZip("hello"));
    expect(Object.keys(exported).sort()).toEqual(["hello/", "hello/SKILL.md", "hello/data.bin", "hello/empty/"]);
    expect(exported["hello/data.bin"]).toEqual(binary);
    expect(await store.files("hello")).toHaveLength(2);
  });

  it("删除先移至 .tmp-del，加载器看不到半删状态且最终清理", async () => {
    await store.importSkillMd(md(), { overwrite: false });
    const rm = fs.rm.bind(fs);
    const remove = vi.spyOn(fs, "rm").mockImplementation(async (file, opts) => {
      expect(path.dirname(String(file))).toBe(dir);
      expect(path.basename(String(file))).toMatch(/^\.tmp-del-/);
      expect((await loader.load()).skills).toEqual([]);
      expect(await store.list()).toEqual([]);
      return rm(file, opts);
    });
    await store.remove("hello"); remove.mockRestore();
    expect(await fs.readdir(dir)).toEqual([]);
    await expect(store.remove("hello")).rejects.toMatchObject({ status: 404 });
  });

  it("拒绝技能根、父目录、技能目录和 SKILL.md 链接，不触碰外部内容", async () => {
    const outside = path.join(root, "outside"); await put(path.join(outside, "SKILL.md"), md());
    await fs.mkdir(dir);
    await fs.symlink(outside, path.join(dir, "hello"), "junction");
    for (const action of [() => store.readSkillMd("hello"), () => store.exportZip("hello"), () => store.remove("hello"), () => store.importSkillMd(md(), { overwrite: true })]) await expect(action()).rejects.toMatchObject({ status: 400 });
    await fs.mkdir(path.join(dir, "other")); await fs.symlink(outside, path.join(dir, "other/SKILL.md"), "junction");
    await expect(store.readSkillMd("other")).rejects.toMatchObject({ status: 400 });
    const alias = path.join(root, "alias"); await fs.symlink(outside, alias, "junction");
    for (const linked of [alias, path.join(alias, "new")]) {
      const target = new SkillsStore({ dir: linked, loader: new SkillsLoader({ dir: linked }) });
      await expect(target.importSkillMd(md(), { overwrite: true })).rejects.toMatchObject({ status: 400 });
    }
    expect(await fs.readdir(outside)).toEqual(["SKILL.md"]);
  });
});
