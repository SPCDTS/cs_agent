import { parseSkill, type Skill, type SkillInput, type SkillSummary } from "../skills";
import { CapabilityFiles } from "./capability-files";

// skills 表保留目录展示信息和已发布附件名，正文及附件只在共享路径保存一份。
export class CapabilitySkills {
  constructor(
    private readonly sql: SqlStorage,
    private readonly files: CapabilityFiles
  ) {}
  migrate() {
    for (const row of this.sql.exec<{ name: string; body: string; files_json: string }>(
      "SELECT name,body,files_json FROM skills WHERE body<>''"
    )) {
      const prefix = "skills/" + row.name + "/";
      this.files.put(prefix + "SKILL.md", row.body);
      const files: Record<string, string> = JSON.parse(row.files_json);
      for (const [path, text] of Object.entries(files)) this.files.put(prefix + path, text);
      this.sql.exec("UPDATE skills SET body='',files_json=? WHERE name=?", JSON.stringify(Object.keys(files)), row.name);
    }
  }
  list(): SkillSummary[] {
    return this.sql
      .exec<{ name: string; description: string; enabled: number; updated_at: number; files_json: string }>(
        "SELECT name,description,enabled,updated_at,files_json FROM skills ORDER BY name"
      )
      .toArray()
      .map((row) => ({
        name: row.name,
        description: row.description,
        enabled: !!row.enabled,
        updatedAt: row.updated_at,
        files: JSON.parse(row.files_json) as string[]
      }));
  }
  get(name: string): Skill | undefined {
    const row = this.sql
      .exec<{
        description: string;
        enabled: number;
        updated_at: number;
        files_json: string;
      }>("SELECT description,enabled,updated_at,files_json FROM skills WHERE name=?", name)
      .toArray()[0];
    if (!row) return;
    const prefix = "skills/" + name + "/",
      paths: string[] = JSON.parse(row.files_json);
    return {
      name,
      description: row.description,
      enabled: !!row.enabled,
      updatedAt: row.updated_at,
      body: this.files.text(prefix + "SKILL.md"),
      files: Object.fromEntries(paths.map((path) => [path, this.files.text(prefix + path)]))
    };
  }
  put(skill: SkillInput) {
    const prefix = "skills/" + skill.name + "/";
    this.files.put(prefix + "SKILL.md", skill.body);
    const previous = this.sql.exec<{ files_json: string }>("SELECT files_json FROM skills WHERE name=?", skill.name).toArray()[0];
    const paths: string[] = previous ? JSON.parse(previous.files_json) : [];
    if (skill.files) {
      for (const path of paths) if (!Object.hasOwn(skill.files, path)) this.files.remove(prefix + path);
      for (const [path, value] of Object.entries(skill.files))
        this.files.put(prefix + path, value, this.files.stat(prefix + path)?.mode);
    }
    this.index(skill.name, skill.description, skill.files ? Object.keys(skill.files) : paths);
  }
  refresh(name: string) {
    const prefix = "skills/" + name + "/",
      markdown = prefix + "SKILL.md";
    if (!this.files.stat(markdown)) {
      this.sql.exec("DELETE FROM skills WHERE name=?", name);
      return;
    }
    const skill = parseSkill(name, this.files.text(markdown));
    // 文件系统可包含二进制和登录文件。read_skill 的附件清单保持发布者选择，脚本可直接打开其他文件。
    const previous = this.sql.exec<{ files_json: string }>("SELECT files_json FROM skills WHERE name=?", name).toArray()[0];
    const paths: string[] = previous ? JSON.parse(previous.files_json) : [];
    this.index(
      name,
      skill.description,
      paths.filter((path) => {
        const file = this.files.stat(prefix + path);
        if (!file || file.hash === "directory" || file.size > 65536) return false;
        try {
          return !this.files.text(prefix + path).includes("\0");
        } catch {
          return false;
        }
      })
    );
  }
  private index(name: string, description: string, paths: string[]) {
    this.sql.exec(
      `INSERT INTO skills(name,description,body,files_json,updated_at) VALUES(?,?,'',?,?)
      ON CONFLICT(name) DO UPDATE SET description=excluded.description,files_json=excluded.files_json,updated_at=excluded.updated_at`,
      name,
      description,
      JSON.stringify(paths),
      Date.now()
    );
  }
}
