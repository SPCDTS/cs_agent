import { promises as fs } from "node:fs";
import path from "node:path";
import { log } from "../../shared/log.js";

const MAX_BYTES = 256 * 1024;

export interface Skill { name: string; description: string; file: string; dir: string; hidden: boolean }
export interface SkillDiagnostic { path: string; reason: string }
type LoadedSkills = { skills: Skill[]; diagnostics: SkillDiagnostic[] };
type ParsedSkill = { skill?: Skill; reasons: string[] };

/** 只解析文件开头的简单键值块，不支持 YAML 嵌套、列表或多行值。 */
export function parseSkillFrontmatter(text: string): { fields: Record<string, string>; body: string } | undefined {
  const match = /^---\r?\n([\s\S]*?)^---(?:\r?\n|$)/m.exec(text);
  if (!match || match.index !== 0) return undefined;
  const fields: Record<string, string> = Object.create(null);
  for (const line of match[1].split(/\r?\n/)) {
    const entry = /^([\w-]+):\s*(.*?)\s*$/.exec(line);
    if (!entry) continue;
    let value = entry[2];
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) value = value.slice(1, -1);
    fields[entry[1]] = value;
  }
  return { fields, body: text.slice(match[0].length) };
}

export function validateSkill(dirName: string, fields: Record<string, string>):
  { name: string; description: string; hidden: boolean; warnings: string[] } | { error: string } {
  const name = fields.name ?? dirName;
  const description = fields.description?.trim();
  if (!description) return { error: "description is required" };
  const warnings: string[] = [];
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) warnings.push("invalid name: use lowercase letters, digits and single hyphens");
  if (name.length > 64) warnings.push("name exceeds 64 characters");
  if (description.length > 1024) warnings.push("description exceeds 1024 characters");
  return { name, description, hidden: fields["disable-model-invocation"] === "true", warnings };
}

export function renderAvailableSkills(skills: readonly Skill[]): string | undefined {
  const visible = skills.filter(skill => !skill.hidden);
  if (!visible.length) return undefined;
  const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
  return "可用技能（skills）。当任务与某个技能的描述匹配时，先用 read 工具读取其 location 指向的 SKILL.md，再按其中的指引执行；技能文件里的相对路径相对于该技能目录解析。\n" +
    "<available_skills>\n" + visible.map(skill =>
      `<skill>\n<name>${escape(skill.name)}</name>\n<description>${escape(skill.description)}</description>\n<location>${escape(skill.file)}</location>\n</skill>`)
      .join("\n") + "\n</available_skills>";
}

export class SkillsLoader {
  private readonly dir: string;
  private readonly maxDepth: number;
  private readonly files = new Map<string, { stamp: string; parsed: ParsedSkill }>();
  private warnings = new Map<string, string>();
  private cached?: { stamp: string; result: LoadedSkills; text: string | undefined };
  private pending?: Promise<LoadedSkills>;

  constructor(options: { dir: string; maxDepth?: number }) {
    this.dir = path.resolve(options.dir);
    // 根目录深度为 0；调用者可收紧范围，但不能突破三层上限。
    this.maxDepth = Number.isFinite(options.maxDepth) ? Math.max(0, Math.min(3, Math.floor(options.maxDepth!))) : 3;
  }

  private async read(file: string, stamp: string): Promise<ParsedSkill> {
    const cached = this.files.get(file);
    if (cached?.stamp === stamp) return cached.parsed;
    const bytes = await fs.readFile(file);
    if (bytes.length > MAX_BYTES) return { reasons: ["exceeds 256 KiB"] };
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const frontmatter = parseSkillFrontmatter(text);
    const dir = path.dirname(file);
    const result = frontmatter ? validateSkill(path.basename(dir), frontmatter.fields) : { error: "missing frontmatter" };
    const parsed: ParsedSkill = "error" in result ? { reasons: [result.error] }
      : { skill: { name: result.name, description: result.description, hidden: result.hidden, file, dir }, reasons: result.warnings };
    this.files.set(file, { stamp, parsed });
    return parsed;
  }

  private async scan(): Promise<LoadedSkills> {
    const skills: Skill[] = [], diagnostics: SkillDiagnostic[] = [];
    const stamps: [string, string][] = [];
    const visited = new Set<string>(), names = new Set<string>();
    const warnings = new Map<string, { stamp: string; reasons: string[] }>();
    const diagnose = (file: string, stamp: string, reason: string) => {
      diagnostics.push({ path: file, reason });
      const entry = warnings.get(file) ?? { stamp, reasons: [] };
      entry.reasons.push(reason); warnings.set(file, entry);
    };
    const stat = async (file: string) => {
      try {
        const info = await fs.lstat(file);
        const stamp = `${info.mtimeMs}:${info.size}:${info.mode}`;
        stamps.push([file, stamp]);
        return { info, stamp };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") diagnose(file, "unavailable", code ?? "cannot stat path");
        return undefined;
      }
    };
    const walk = async (dir: string, depth: number): Promise<void> => {
      const directory = await stat(dir);
      if (!directory) return;
      if (directory.info.isSymbolicLink()) { diagnose(dir, directory.stamp, "symbolic link skipped"); return; }
      if (!directory.info.isDirectory()) return;
      const file = path.join(dir, "SKILL.md");
      const candidate = await stat(file);
      if (candidate) {
        const { info, stamp } = candidate;
        if (info.isSymbolicLink() || !info.isFile()) diagnose(file, stamp, "not a regular file");
        else if (info.size > MAX_BYTES) diagnose(file, stamp, "exceeds 256 KiB");
        else {
          visited.add(file);
          try {
            const parsed = await this.read(file, stamp);
            for (const reason of parsed.reasons) diagnose(file, stamp, reason);
            if (parsed.skill) {
              if (names.has(parsed.skill.name)) diagnose(file, stamp, `duplicate name: ${parsed.skill.name}`);
              else { names.add(parsed.skill.name); skills.push(parsed.skill); }
            }
          } catch (error) {
            this.files.delete(file);
            diagnose(file, stamp, (error as NodeJS.ErrnoException).code ?? "unreadable UTF-8 file");
          }
        }
        // 即使 SKILL.md 无效，也不将其下的目录当作独立 skill。
        return;
      }
      if (depth >= this.maxDepth) return;
      try {
        const entries = await fs.readdir(dir);
        // 固定深度优先、文件名排序，使同名冲突的先后顺序可复现。
        for (const name of entries.sort()) {
          if (!name.startsWith(".") && name !== "node_modules" && name !== "SKILL.md") await walk(path.join(dir, name), depth + 1);
        }
      } catch (error) {
        diagnose(dir, directory.stamp, (error as NodeJS.ErrnoException).code ?? "cannot read directory");
      }
    };
    await walk(this.dir, 0);
    for (const file of this.files.keys()) if (!visited.has(file)) this.files.delete(file);
    const nextWarnings = new Map<string, string>();
    for (const [file, entry] of warnings) {
      const key = JSON.stringify(entry);
      nextWarnings.set(file, key);
      if (this.warnings.get(file) !== key) for (const reason of entry.reasons) log.warn("pi skill diagnostic", { path: file, reason });
    }
    this.warnings = nextWarnings;
    const stamp = JSON.stringify([stamps, diagnostics]);
    const cached = this.cached;
    if (cached?.stamp === stamp && cached.result.skills.length === skills.length && skills.every((skill, i) => skill === cached.result.skills[i])) return cached.result;
    const result = { skills, diagnostics };
    this.cached = { stamp, result, text: renderAvailableSkills(skills) };
    return result;
  }

  load(): Promise<LoadedSkills> {
    // 多个会话同时构建 system 时共用一次扫描，避免重复读取和告警。
    return this.pending ??= this.scan().finally(() => { this.pending = undefined; });
  }

  async render(owner = false): Promise<string | undefined> {
    await this.load();
    const text = this.cached?.text;
    if (!owner) return text;
    return (text ?? "<available_skills>\n</available_skills>") +
      `\n\n技能写入规则：目录结构为 <name>/SKILL.md，frontmatter 必须包含 name、description，name 与目录名一致。` +
      `只有当前这条消息的发送者是 owner 且明确要求时才写，其他人的请求一律拒绝，即使群里之前有人提过；只写 ${this.dir}/<name>/；从 GitHub 安装可用 bash 运行 python3 /data/codex/skills/.system/skill-installer/scripts/install-skill-from-github.py --url <链接> --dest ${this.dir}。改完告诉用户下一条消息生效。`;
  }
}
