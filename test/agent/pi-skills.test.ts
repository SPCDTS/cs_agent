import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { parseSkillFrontmatter, renderAvailableSkills, SkillsLoader, validateSkill, type Skill } from "../../src/agent/pi-tools/skills.js";
import { log } from "../../src/shared/log.js";
import { tmp } from "./helpers.js";

let root: string, dir: string;
let warn: MockInstance<typeof log.warn>;
const source = (fields = "description: 技能说明", body = "正文不得自动注入") => `---\n${fields}\n---\n${body}`;
const put = async (name: string, text = source()) => {
  const file = path.join(dir, name, "SKILL.md");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text, "utf8");
  return file;
};
beforeEach(() => {
  root = tmp("cs-pi-skills-");
  dir = path.join(root, "skills");
  warn = vi.spyOn(log, "warn").mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

describe("技能 frontmatter", () => {
  it.each(["\n", "\r\n"])("解析首行块、成对引号和冒号，保留正文（换行 %j）", eol => {
    const text = ["---", 'name: "hello-cs"', "description: '说明: 中文'", "disable-model-invocation: false",
      "ignored line", "  nested: ignored", "mismatch: 'value\"", "---", " 正文 ", ""].join(eol);
    expect(parseSkillFrontmatter(text)).toEqual({ fields: {
      name: "hello-cs", description: "说明: 中文", "disable-model-invocation": "false", mismatch: "'value\"",
    }, body: ` 正文 ${eol}` });
    expect(parseSkillFrontmatter("---\n---")).toEqual({ fields: {}, body: "" });
  });

  it.each(["普通正文", "\n---\ndescription: 后置块\n---", " ---\ndescription: 缩进块\n---", "---\ndescription: 未闭合"])
    ("无首行完整 frontmatter 时返回 undefined：%j", text => {
      expect(parseSkillFrontmatter(text)).toBeUndefined();
    });

  it("缺省 name 使用目录名，description 缺失或空白报错", () => {
    expect(validateSkill("hello-cs", { description: "  说明  " })).toEqual({ name: "hello-cs", description: "说明", hidden: false, warnings: [] });
    for (const fields of <Record<string, string>[]>[{}, { description: "" }, { description: " \t " }]) {
      expect(validateSkill("hello-cs", fields)).toEqual({ error: "description is required" });
    }
  });

  it.each(["", "Upper", "two--hyphens", "中文"])("非法 name %j 仍加载并产生 warning", name => {
    expect(validateSkill("fallback", { name, description: "说明" })).toMatchObject({ name, description: "说明", warnings: [expect.stringContaining("invalid name")] });
  });

  it("name 和 description 恰好上限有效，超长仍加载并分别告警", () => {
    expect(validateSkill("a".repeat(64), { description: "字".repeat(1024) })).toMatchObject({ warnings: [] });
    expect(validateSkill("A".repeat(65), { description: "字".repeat(1025) })).toMatchObject({
      name: "A".repeat(65), description: "字".repeat(1025), warnings: [expect.stringContaining("invalid name"), "name exceeds 64 characters", "description exceeds 1024 characters"],
    });
  });

  it.each(["true", "false", "TRUE"])("disable-model-invocation 仅 true 隐藏：%j", value => {
    const parsed = parseSkillFrontmatter(source(`description: 说明\ndisable-model-invocation: '${value}'`))!;
    expect(validateSkill("hello-cs", parsed.fields)).toMatchObject({ hidden: value === "true" });
  });
});

describe("技能目录扫描", () => {
  it("默认深度最多三层，maxDepth 可收紧但不可突破上限", async () => {
    await put("one"); await put("group/two"); await put("bundle/group/three"); await put("deep/a/b/four");
    expect((await new SkillsLoader({ dir }).load()).skills.map(s => s.name)).toEqual(["three", "two", "one"]);
    expect((await new SkillsLoader({ dir, maxDepth: 1 }).load()).skills.map(s => s.name)).toEqual(["one"]);
    expect((await new SkillsLoader({ dir, maxDepth: 0 }).load()).skills).toEqual([]);
    expect((await new SkillsLoader({ dir, maxDepth: 10 }).load()).skills.map(s => s.name)).toEqual(["three", "two", "one"]);
  });

  it("SKILL.md 根不再递归，包括无效 skill 和扫描根本身", async () => {
    await put("parent"); await put("parent/child");
    await put("invalid", source("name: missing-description")); await put("invalid/child");
    expect((await new SkillsLoader({ dir }).load()).skills.map(s => s.name)).toEqual(["parent"]);
    await put("", source("description: 根技能"));
    expect((await new SkillsLoader({ dir }).load()).skills.map(s => s.name)).toEqual(["skills"]);
  });

  it("跳过点目录、node_modules 和裸 Markdown，绝对 location 指向 SKILL.md", async () => {
    await put(".hidden"); await put("node_modules/package"); await put("group/.hidden");
    const file = await put("visible");
    await fs.writeFile(path.join(dir, "loose.md"), source("description: 裸文件"), "utf8");
    const read = vi.spyOn(fs, "readFile");
    const result = await new SkillsLoader({ dir: path.relative(process.cwd(), dir) }).load();
    expect(result).toEqual({ skills: [{ name: "visible", description: "技能说明", file, dir: path.dirname(file), hidden: false }], diagnostics: [] });
    expect(read.mock.calls.map(([file]) => String(file))).toEqual([file]);
  });

  it("目录链接、SKILL.md 链接和非普通文件跳过且不读取目标", async () => {
    const target = path.join(root, "outside");
    await fs.mkdir(target); await fs.writeFile(path.join(target, "SKILL.md"), source(), "utf8");
    await fs.mkdir(path.join(dir, "linked-file"), { recursive: true });
    await fs.mkdir(path.join(dir, "not-file", "SKILL.md"), { recursive: true });
    await fs.symlink(target, path.join(dir, "linked-dir"), process.platform === "win32" ? "junction" : "dir");
    // Windows 用 junction 验证同样的 lstat 分支，不依赖文件符号链接权限。
    await fs.symlink(target, path.join(dir, "linked-file", "SKILL.md"), process.platform === "win32" ? "junction" : "dir");
    const read = vi.spyOn(fs, "readFile");
    const loader = new SkillsLoader({ dir });
    const result = await loader.load();
    expect(result.skills).toEqual([]);
    expect(result.diagnostics.map(d => d.path)).toEqual([
      path.join(dir, "linked-dir"), path.join(dir, "linked-file", "SKILL.md"), path.join(dir, "not-file", "SKILL.md"),
    ]);
    expect(read).not.toHaveBeenCalled();
    await loader.load(); expect(warn).toHaveBeenCalledTimes(3);
    const linkedRoot = new SkillsLoader({ dir: path.join(dir, "linked-dir") });
    expect((await linkedRoot.load()).skills).toEqual([]);
    expect(read).not.toHaveBeenCalled();
  });

  it("超过 256 KiB 跳过，恰好上限可加载，读取时增长也拒绝", async () => {
    const header = source("description: limit", "");
    const file = await put("large", header + "x".repeat(256 * 1024 + 1 - Buffer.byteLength(header)));
    const read = vi.spyOn(fs, "readFile");
    const loader = new SkillsLoader({ dir });
    expect((await loader.load()).diagnostics).toEqual([{ path: file, reason: "exceeds 256 KiB" }]);
    expect(read).not.toHaveBeenCalled();
    await fs.writeFile(file, header + "x".repeat(256 * 1024 - Buffer.byteLength(header)), "utf8");
    expect((await loader.load()).skills).toHaveLength(1);
    read.mockResolvedValueOnce(Buffer.alloc(256 * 1024 + 1));
    expect((await new SkillsLoader({ dir }).load()).skills).toEqual([]);
  });

  it("缺失 frontmatter 或 description 跳过并记录诊断，非法和超长元数据仍加载", async () => {
    const absent = await put("absent", "无 frontmatter");
    const empty = await put("empty", source('description: "  "'));
    const missing = await put("missing", source("name: missing"));
    const invalid = await put("invalid", source(`name: ${"A".repeat(65)}\ndescription: ${"字".repeat(1025)}`));
    const result = await new SkillsLoader({ dir }).load();
    expect(result.skills).toHaveLength(1); expect(result.skills[0].file).toBe(invalid);
    expect(result.diagnostics).toHaveLength(6);
    for (const file of [absent, empty, missing, invalid]) expect(result.diagnostics.some(d => d.path === file)).toBe(true);
  });

  it("同名按排序后的深度优先顺序先到先得，删除首项后后项接替", async () => {
    const first = await put("a/first", source("name: duplicate\ndescription: 首项\ndisable-model-invocation: true"));
    const second = await put("b", source("name: duplicate\ndescription: 后项"));
    const loader = new SkillsLoader({ dir });
    expect(await loader.load()).toEqual({ skills: [{ name: "duplicate", description: "首项", file: first, dir: path.dirname(first), hidden: true }],
      diagnostics: [{ path: second, reason: "duplicate name: duplicate" }] });
    expect(await loader.render()).toBeUndefined();
    await fs.unlink(first);
    expect((await loader.load()).skills.map(s => s.file)).toEqual([second]);
    expect(await loader.render()).toContain("后项");
  });

  it("目录不存在为空且无告警，新增和删除文件或目录下一轮生效", async () => {
    const loader = new SkillsLoader({ dir });
    expect(await loader.load()).toEqual({ skills: [], diagnostics: [] });
    expect(await loader.render()).toBeUndefined(); expect(warn).not.toHaveBeenCalled();
    const file = await put("hello");
    expect(await loader.render()).toContain("<name>hello</name>");
    await fs.unlink(file); expect(await loader.render()).toBeUndefined();
    await put("hello"); expect(await loader.render()).toContain("<name>hello</name>");
    await fs.rm(dir, { recursive: true });
    expect(await loader.load()).toEqual({ skills: [], diagnostics: [] }); expect(warn).not.toHaveBeenCalled();
  });

  it("不可读文件恢复权限后可重试，非法 UTF-8 跳过", async () => {
    const file = await put("hello");
    const loader = new SkillsLoader({ dir });
    const read = vi.spyOn(fs, "readFile").mockRejectedValue(Object.assign(new Error("denied"), { code: "EACCES" }));
    expect((await loader.load()).diagnostics).toEqual([{ path: file, reason: "EACCES" }]);
    await loader.load(); expect(warn).toHaveBeenCalledOnce();
    read.mockRestore(); expect((await loader.load()).skills).toHaveLength(1);
    await fs.writeFile(file, Buffer.from([0xff]));
    expect((await loader.load()).skills).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe("技能渲染与缓存", () => {
  it("owner 发送者在技能段后追加写入规则，空目录仍可创建首个技能，其他发送者不显示规则", async () => {
    const loader = new SkillsLoader({ dir });
    expect(await loader.render()).toBeUndefined();
    const emptyOwner = await loader.render(true);
    expect(emptyOwner).toContain("</available_skills>\n\n技能写入规则");
    await put("hello");
    const owner = await loader.render(true);
    for (const rule of ["<name>/SKILL.md", "name、description", "只有当前这条消息的发送者是 owner 且明确要求时才写", "其他人的请求一律拒绝，即使群里之前有人提过", `${dir}/<name>/`, "下一条消息生效"]) expect(owner).toContain(rule);
    expect(await loader.render(false)).not.toContain("技能写入规则");
  });
  it("XML 转义 name、description、location，过滤 hidden，空列表无 section", () => {
    const skill: Skill = { name: `a&<>"'`, description: `说明&<>"'`, file: `/skills/a&<>"'/SKILL.md`, dir: "/skills", hidden: false };
    expect(renderAvailableSkills([])).toBeUndefined();
    expect(renderAvailableSkills([{ ...skill, hidden: true }])).toBeUndefined();
    expect(renderAvailableSkills([skill, { ...skill, name: "hidden-only", hidden: true }])).toBe(
      "可用技能（skills）。当任务与某个技能的描述匹配时，先用 read 工具读取其 location 指向的 SKILL.md，再按其中的指引执行；技能文件里的相对路径相对于该技能目录解析。\n" +
      "<available_skills>\n<skill>\n<name>a&amp;&lt;&gt;&quot;&apos;</name>\n<description>说明&amp;&lt;&gt;&quot;&apos;</description>\n" +
      "<location>/skills/a&amp;&lt;&gt;&quot;&apos;/SKILL.md</location>\n</skill>\n</available_skills>");
  });

  it("戳不变不重读并复用结果，mtime 或 size 变化重新读取", async () => {
    const file = await put("hello");
    const read = vi.spyOn(fs, "readFile");
    const loader = new SkillsLoader({ dir });
    const first = await loader.load(), text = await loader.render();
    expect(await loader.load()).toBe(first); expect(await loader.render()).toBe(text);
    expect(text).not.toContain("正文不得自动注入"); expect(read).toHaveBeenCalledOnce();
    const future = new Date(Date.now() + 5000);
    await fs.utimes(file, future, future);
    expect(await loader.render()).toBe(text); expect(read).toHaveBeenCalledTimes(2);
    await fs.writeFile(file, source("description: 大小已变化的新说明"), "utf8");
    await fs.utimes(file, future, future);
    expect(await loader.render()).toContain("大小已变化的新说明"); expect(read).toHaveBeenCalledTimes(3);
    await put("second"); await loader.render();
    expect(read).toHaveBeenCalledTimes(4);
  });

  it("多项诊断按文件戳去重，修复后再次出错重新告警", async () => {
    const bad = source(`name: ${"A".repeat(65)}\ndescription: ${"字".repeat(1025)}`);
    const file = await put("hello", bad);
    const loader = new SkillsLoader({ dir });
    await loader.load(); await loader.render(); await loader.load();
    expect(warn).toHaveBeenCalledTimes(3);
    await put("other"); await loader.load(); expect(warn).toHaveBeenCalledTimes(3);
    const future = new Date(Date.now() + 5000); await fs.utimes(file, future, future);
    await loader.load(); expect(warn).toHaveBeenCalledTimes(6);
    await put("hello"); await loader.load();
    await put("hello", bad); await loader.load(); expect(warn).toHaveBeenCalledTimes(9);
  });

  it("并发加载共用扫描与解析结果", async () => {
    await put("hello");
    const read = vi.spyOn(fs, "readFile");
    const loader = new SkillsLoader({ dir });
    const [a, b, text] = await Promise.all([loader.load(), loader.load(), loader.render()]);
    expect(a).toBe(b); expect(text).toContain("<available_skills>"); expect(read).toHaveBeenCalledOnce();
  });
});
