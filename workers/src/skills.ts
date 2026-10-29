import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";

export const SKILLS_SCHEMA = `CREATE TABLE IF NOT EXISTS skills (name TEXT PRIMARY KEY, description TEXT NOT NULL, body TEXT NOT NULL,
  files_json TEXT NOT NULL, updated_at INTEGER NOT NULL, enabled INTEGER NOT NULL DEFAULT 1)`;

/** body 是整份 SKILL.md（含 frontmatter）：面板原样编辑，read_skill 原样返回，frontmatter 里其他字段不会丢。 */
export type SkillInput = { name: string; description: string; body: string; files?: Record<string, string> };
export type Skill = Required<SkillInput> & { enabled: boolean; updatedAt: number };
export type SkillSummary = { name: string; description: string; enabled: boolean; updatedAt: number; files: string[] };

export const SKILL_LIMITS = { markdownBytes: 256 * 1024, fileBytes: 64 * 1024, filesBytes: 512 * 1024, description: 500, readChars: 20_000 };
export type SkillErrorCode = "invalid_name" | "missing_frontmatter" | "name_mismatch" | "missing_description" | "description_too_long"
  | "skill_too_large" | "invalid_path" | "invalid_file" | "file_too_large" | "files_too_large";
export class SkillError extends Error {
  constructor(readonly code: SkillErrorCode) { super(code); }
}

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const bytes = (text: string) => new TextEncoder().encode(text).byteLength;
const validPath = (path: string) => path.length <= 200 && path !== "SKILL.md" && !path.startsWith("/") && !path.includes("..")
  && !/[\\\x00-\x1f\x7f]/.test(path) && path.split("/").every(part => part !== "" && part !== ".");

/** 与 Docker 版相同：只解析文件开头的简单键值块，不支持 YAML 嵌套、列表或多行值。 */
export function parseSkillFrontmatter(text: string): Record<string, string> | undefined {
  const match = /^---\r?\n([\s\S]*?)^---(?:\r?\n|$)/m.exec(text);
  if (!match || match.index !== 0) return undefined;
  const fields: Record<string, string> = Object.create(null);
  for (const line of match[1]!.split(/\r?\n/)) {
    const entry = /^([\w-]+):\s*(.*?)\s*$/.exec(line);
    if (!entry) continue;
    let value = entry[2]!;
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) value = value.slice(1, -1);
    fields[entry[1]!] = value;
  }
  return fields;
}

/** 面板写入的唯一入口；files 省略表示保留已有附件。 */
export function parseSkill(name: string, markdown: string, files?: Record<string, string>): SkillInput {
  if (!NAME.test(name)) throw new SkillError("invalid_name");
  if (bytes(markdown) > SKILL_LIMITS.markdownBytes) throw new SkillError("skill_too_large");
  const fields = parseSkillFrontmatter(markdown);
  if (!fields) throw new SkillError("missing_frontmatter");
  // 与 Docker 一样，frontmatter 没写 name 时以目录名（这里是 URL 里的名字）为准。
  if ((fields.name ?? name) !== name) throw new SkillError("name_mismatch");
  const description = fields.description?.trim();
  if (!description) throw new SkillError("missing_description");
  if ([...description].length > SKILL_LIMITS.description) throw new SkillError("description_too_long");
  if (files) {
    let total = 0;
    for (const [path, text] of Object.entries(files)) {
      if (!validPath(path)) throw new SkillError("invalid_path");
      if (text.includes("\0")) throw new SkillError("invalid_file");
      const size = bytes(text);
      if (size > SKILL_LIMITS.fileBytes) throw new SkillError("file_too_large");
      if ((total += size) > SKILL_LIMITS.filesBytes) throw new SkillError("files_too_large");
    }
  }
  return { name, description, body: markdown, ...(files ? { files } : {}) };
}

const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
export function renderAvailableSkills(skills: readonly Pick<SkillSummary, "name" | "description">[]): string | undefined {
  if (!skills.length) return undefined;
  return "可用技能（skills）。当任务与某个技能的描述匹配时，先用 read_skill 读取它的 SKILL.md，再按其中的指引执行；技能里提到的附件用 read_skill 的 path 参数按相对路径读取。技能只能在管理面板新建或修改。\n"
    + "<available_skills>\n" + skills.map(skill => `<skill>\n<name>${escape(skill.name)}</name>\n<description>${escape(skill.description)}</description>\n</skill>`).join("\n")
    + "\n</available_skills>";
}

function readSkill(skill: Skill | undefined, name: string, path: string | undefined): string {
  if (!skill?.enabled) return `技能 ${name} 不存在或已停用。`;
  const text = path === undefined || path === "SKILL.md" ? skill.body : skill.files[path];
  if (text === undefined) {
    const names = Object.keys(skill.files);
    return `技能 ${name} 没有文件 ${path}。${names.length ? "可用文件：" + names.join("、") : "这个技能没有附件。"}`;
  }
  const chars = [...text];
  return chars.length <= SKILL_LIMITS.readChars ? text : chars.slice(0, SKILL_LIMITS.readChars).join("") + `\n…（已截断，全文 ${chars.length} 字）`;
}

type SkillSource = { skillsDigest(): Promise<string>; skillsList(): Promise<SkillSummary[]>; skillGet(name: string): Promise<Skill | undefined> };
const CATALOG_TTL_MS = 60_000;

/** Thread 侧的技能目录：section 文本缓存 60 秒，到期先比 digest，变了才重新取列表渲染。 */
export class SkillCatalog {
  private cache?: { at: number; digest: string; text: string | undefined };
  constructor(private readonly registry: () => SkillSource) {}

  async section(): Promise<string | undefined> {
    const cache = this.cache;
    if (cache && Date.now() - cache.at < CATALOG_TTL_MS) return cache.text;
    try {
      const registry = this.registry(), digest = await registry.skillsDigest();
      const text = cache?.digest === digest ? cache.text : renderAvailableSkills((await registry.skillsList()).filter(skill => skill.enabled));
      this.cache = { at: Date.now(), digest, text };
      return text;
    } catch {
      // Registry 暂时取不到时沿用上一份目录，不让回合因技能列表失败；下一次请求再重试。
      return cache?.text;
    }
  }

  tool() {
    return defineTool({
      name: "read_skill",
      description: "读取已启用技能的 SKILL.md（不传 path）或它的附件（path 为技能内的相对路径），返回文本，超过 20000 字截断。",
      parameters: Type.Object({ name: Type.String({ minLength: 1, maxLength: 64 }), path: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })) },
        { additionalProperties: false }),
      replay: "safe",
      execute: async ({ name, path }) => ({ output: [{ type: "text", text: readSkill(await this.registry().skillGet(name), name, path) }] }),
    });
  }
}
