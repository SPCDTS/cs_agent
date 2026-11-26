import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { SkillGroupSchema, SkillNameSchema } from "./manifest";

export const SKILL_RUNTIME_GRANT_SCHEMA = `
CREATE TABLE IF NOT EXISTS skill_runtime_grants (
  skill TEXT NOT NULL,
  scope TEXT NOT NULL,
  actions_json TEXT NOT NULL,
  revision TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(skill, scope)
);
CREATE INDEX IF NOT EXISTS skill_runtime_grants_by_scope ON skill_runtime_grants(scope, skill);`;

export const SkillRuntimeGrantEntrySchema = Type.Object({
  skill: SkillNameSchema,
  revision: Type.String({ minLength: 1, maxLength: 64 }),
  // 兼容升级前尚未结束的子任务快照
  actions: Type.Optional(Type.Array(Type.String())),
}, { additionalProperties: false });

export const SkillRuntimeSnapshotSchema = Type.Object({
  scope: Type.String({ minLength: 1, maxLength: 64 }),
  grants: Type.Array(SkillRuntimeGrantEntrySchema),
}, { additionalProperties: false });

export type SkillRuntimeGrantEntry = Static<typeof SkillRuntimeGrantEntrySchema>;
export type SkillRuntimeSnapshot = Static<typeof SkillRuntimeSnapshotSchema>;
export type SkillRuntimeGrantRecord = { skill: string; scope: string; revision: string; updatedAt: number };

type Row = { skill: string; scope: string; revision: string; updated_at: number };

const toRecord = (row: Row): SkillRuntimeGrantRecord => ({
  skill: row.skill,
  scope: row.scope,
  revision: row.revision,
  updatedAt: row.updated_at,
});

/** 持久化按 Skill 与群粒度拆分的加密状态沙箱授权。 */
export class SkillGrantStore {
  constructor(private readonly sql: SqlStorage) {}

  list(skill?: string): SkillRuntimeGrantRecord[] {
    if (skill !== undefined) {
      if (!Check(SkillNameSchema, skill)) throw new Error("invalid_skill");
      return this.sql.exec<Row>("SELECT skill, scope, revision, updated_at FROM skill_runtime_grants WHERE skill=? ORDER BY scope", skill).toArray().map(toRecord);
    }
    return this.sql.exec<Row>("SELECT skill, scope, revision, updated_at FROM skill_runtime_grants ORDER BY skill, scope").toArray().map(toRecord);
  }

  forScope(scope: string): SkillRuntimeGrantRecord[] {
    if (!Check(SkillGroupSchema, scope)) return [];
    return this.sql.exec<Row>("SELECT skill, scope, revision, updated_at FROM skill_runtime_grants WHERE scope=? ORDER BY skill", scope).toArray().map(toRecord);
  }

  set(skill: string, group: string, enabled: boolean, now = Date.now()): { skill: string; group: string; enabled: boolean; revision: string } {
    if (!Check(SkillNameSchema, skill) || !Check(SkillGroupSchema, group)) throw new Error("skill_invalid_grant");
    if (!enabled) {
      this.sql.exec("DELETE FROM skill_runtime_grants WHERE skill=? AND scope=?", skill, group);
      return { skill, group, enabled: false, revision: "" };
    }
    const existingCount = this.sql.exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM skill_runtime_grants WHERE skill=? AND scope<>?",
      skill,
      group,
    ).one().count;
    if (existingCount >= 64) throw new Error("skill_grant_limit");
    const revision = crypto.randomUUID();
    this.sql.exec(
      `INSERT INTO skill_runtime_grants(skill, scope, actions_json, revision, updated_at) VALUES(?,?,?,?,?)
       ON CONFLICT(skill, scope) DO UPDATE SET actions_json=excluded.actions_json, revision=excluded.revision, updated_at=excluded.updated_at`,
      skill,
      group,
      '["*"]',
      revision,
      now,
    );
    return { skill, group, enabled: true, revision };
  }

  deleteSkill(skill: string): void {
    this.sql.exec("DELETE FROM skill_runtime_grants WHERE skill=?", skill);
  }
}
