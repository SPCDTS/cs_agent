import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { ProjectContextLoader, renderProjectContext, type ProjectContextOptions } from "../../src/agent/pi-tools/project-context.js";
import { log } from "../../src/shared/log.js";
import { tmp } from "./helpers.js";

const loadProjectContextFiles = (o: ProjectContextOptions) => new ProjectContextLoader(o).load(o.cwd);

const names = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];
let root: string, dataDir: string, workspaceDir: string, cwd: string;
let warn: MockInstance<typeof log.warn>;
const put = async (file: string, text: string | Uint8Array) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text, "utf8");
  return file;
};
const options = () => ({ dataDir, workspaceDir, cwd });
beforeEach(() => {
  root = tmp("cs-pi-context-");
  dataDir = path.join(root, "data");
  workspaceDir = path.join(root, "workspace");
  cwd = path.join(dataDir, "pi-work", "group_7");
  warn = vi.spyOn(log, "warn").mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

describe("pi 项目上下文", () => {
  it.each(names)("候选顺序从 %s 开始，选中后不再读取低优先级文件", async selected => {
    // 用精确路径桩覆盖大小写敏感语义，Windows 磁盘不能同时保存 md / MD。
    const start = names.indexOf(selected);
    const stat = await fs.stat(root);
    const lstat = vi.spyOn(fs, "lstat").mockImplementation(async file => {
      const name = path.basename(String(file));
      if (names.indexOf(name) < start) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return { ...stat, isFile: () => true, isSymbolicLink: () => false } as typeof stat;
    });
    const read = vi.spyOn(fs, "readFile").mockResolvedValue(Buffer.from("候选内容"));
    const files = await loadProjectContextFiles({ dataDir, workspaceDir });
    expect(files).toEqual([{ path: path.join(workspaceDir, selected), content: "候选内容" }]);
    expect(lstat.mock.calls.map(([file]) => path.basename(String(file)))).toEqual(names.slice(0, start + 1));
    expect(read).toHaveBeenCalledOnce();
  });

  it("运维层在会话层之前，去 BOM 并保留正文空格", async () => {
    const outer = await put(path.join(workspaceDir, "AGENTS.override.md"), "\uFEFF运维指引");
    await put(path.join(workspaceDir, "AGENTS.md"), "被 override 遮蔽");
    const inner = await put(path.join(cwd, "AGENTS.md"), " 会话指引\n");
    expect(await loadProjectContextFiles(options())).toEqual([
      { path: outer, content: "运维指引" }, { path: inner, content: " 会话指引\n" },
    ]);
  });

  it("目录重合时只加载一次", async () => {
    await put(path.join(cwd, "AGENTS.md"), "同一个文件");
    expect(await loadProjectContextFiles({ ...options(), workspaceDir: cwd })).toHaveLength(1);
  });

  it("不读取 WORKSPACE_DIR 上级、DATA_DIR、pi-work 根和会话子目录", async () => {
    for (const dir of [root, dataDir, path.dirname(cwd), path.join(cwd, "nested")]) {
      await put(path.join(dir, "AGENTS.md"), "不应注入");
    }
    expect(await new ProjectContextLoader(options()).render(cwd)).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it("无环境时只读运维层，非法 cwd 每个值只告警一次", async () => {
    await put(path.join(workspaceDir, "AGENTS.md"), "运维指引");
    const loader = new ProjectContextLoader(options());
    const expected = await loader.render();
    expect(expected).toContain("运维指引");
    for (const bad of [dataDir, path.dirname(cwd), path.join(cwd, "nested"), path.join(root, "elsewhere"), "relative"]) {
      expect(await loader.render(bad)).toBe(expected);
      expect(await loader.render(bad)).toBe(expected);
    }
    expect(warn).toHaveBeenCalledTimes(5);
  });

  it("符号链接和目录不作为文件读取，告警不重复", async () => {
    await fs.mkdir(workspaceDir, { recursive: true });
    const target = path.join(root, "target");
    await fs.mkdir(target);
    // Windows junction 不需要创建文件符号链接的额外权限；lstat 仍报告符号链接。
    await fs.symlink(target, path.join(workspaceDir, "AGENTS.override.md"), process.platform === "win32" ? "junction" : "dir");
    await fs.mkdir(path.join(workspaceDir, "AGENTS.md"));
    await put(path.join(workspaceDir, "CLAUDE.md"), "可读候选");
    const read = vi.spyOn(fs, "readFile");
    const loader = new ProjectContextLoader(options());
    expect(await loader.render()).toContain("可读候选");
    await loader.render();
    expect(read.mock.calls.map(([file]) => path.basename(String(file)))).toEqual(["CLAUDE.md"]);
    expect(warn.mock.calls.some(([, fields]) => fields?.path === path.join(workspaceDir, "AGENTS.override.md"))).toBe(true);
    expect(warn).toHaveBeenCalledTimes(process.platform === "win32" ? 3 : 2);
  });

  it("大于 128 KiB 时跳过，每次文件变化只告警一次，恰好上限可读", async () => {
    const file = await put(path.join(workspaceDir, "AGENTS.md"), "x".repeat(128 * 1024 + 1));
    const read = vi.spyOn(fs, "readFile");
    const loader = new ProjectContextLoader(options());
    expect(await loader.render()).toBeUndefined();
    await loader.render();
    expect(read).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    await put(file, "x".repeat(128 * 1024 + 2));
    await loader.render();
    expect(warn).toHaveBeenCalledTimes(2);
    await put(file, "x".repeat(128 * 1024));
    expect(await loader.render()).toContain("x".repeat(128 * 1024));
  });

  it("不可读文件被省略且恢复读取权限后可重试，非法 UTF-8 也告警", async () => {
    const file = await put(path.join(workspaceDir, "AGENTS.md"), "可恢复");
    const read = vi.spyOn(fs, "readFile").mockRejectedValue(Object.assign(new Error("denied"), { code: "EACCES" }));
    const loader = new ProjectContextLoader(options());
    expect(await loader.render()).toBeUndefined();
    await loader.render();
    expect(warn).toHaveBeenCalledTimes(1);
    read.mockRestore();
    expect(await loader.render()).toContain("可恢复");
    await put(file, Uint8Array.from([0xff]));
    expect(await loader.render()).toBeUndefined();
    await loader.render();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("缺失或空白文件省略，新增、更换 override 和删除文件会刷新", async () => {
    const loader = new ProjectContextLoader(options());
    expect(await loader.render()).toBeUndefined();
    const file = await put(path.join(cwd, "AGENTS.md"), "\uFEFF \r\n\t");
    expect(await loader.render(cwd)).toBeUndefined();
    await put(file, "新增内容");
    expect(await loader.render(cwd)).toContain("新增内容");
    const override = await put(path.join(cwd, "AGENTS.override.md"), "覆盖内容");
    expect(await loader.render(cwd)).toContain("覆盖内容");
    await fs.unlink(override);
    expect(await loader.render(cwd)).toContain("新增内容");
    await fs.unlink(file);
    expect(await loader.render(cwd)).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it("戳不变不重读且复用文件和渲染结果，改戳不改正文也保持相同字符串", async () => {
    const file = await put(path.join(cwd, "AGENTS.md"), "会话内容");
    const read = vi.spyOn(fs, "readFile");
    const loader = new ProjectContextLoader(options());
    const first = await loader.render(cwd);
    const files = await loader.load(cwd);
    expect((await loader.load(cwd))[0]).toBe(files[0]);
    expect(await loader.render(cwd)).toBe(first);
    expect(read).toHaveBeenCalledOnce();
    const future = new Date(Date.now() + 2000);
    await fs.utimes(file, future, future);
    expect(await loader.render(cwd)).toBe(first);
    expect(read).toHaveBeenCalledTimes(2);
    await put(file, "新内容");
    expect(await loader.render(cwd)).toContain("新内容");
  });

  it("并发渲染不同会话不会串用上下文", async () => {
    const other = path.join(dataDir, "pi-work", "private_1");
    await put(path.join(cwd, "AGENTS.md"), "群聊指引");
    await put(path.join(other, "AGENTS.md"), "私聊指引");
    const loader = new ProjectContextLoader(options());
    const [group, privateText] = await Promise.all([loader.render(cwd), loader.render(other)]);
    expect(group).toContain("群聊指引"); expect(group).not.toContain("私聊指引");
    expect(privateText).toContain("私聊指引"); expect(privateText).not.toContain("群聊指引");
    expect(await loader.render(cwd)).toBe(group);
  });

  it("渲染格式快照，空集合不产生 section", () => {
    expect(renderProjectContext([])).toBeUndefined();
    expect(renderProjectContext([
      { path: "/workspace/AGENTS.md", content: "运维指引" },
      { path: "/data/pi-work/group_7/AGENTS.md", content: "会话指引" },
    ])).toMatchInlineSnapshot(`
      "Project-specific instructions and guidelines:

      <project_instructions path="/workspace/AGENTS.md">
      运维指引
      </project_instructions>

      <project_instructions path="/data/pi-work/group_7/AGENTS.md">
      会话指引
      </project_instructions>"
    `);
    expect(renderProjectContext([{ path: '/workspace/a&"<>.md', content: "原文" }]))
      .toContain('path="/workspace/a&amp;&quot;&lt;&gt;.md"');
  });
});
