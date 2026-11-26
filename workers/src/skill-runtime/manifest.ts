import { Type } from "typebox";

export const SKILL_MAX_OUTPUT_FILES = 5;
export const SKILL_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
export const SKILL_STATE_FILE_MAX_BYTES = 10 * 1024 * 1024;
export const SKILL_STATE_MAX_BYTES = 50 * 1024 * 1024;

export const SkillNameSchema = Type.String({ pattern: "^[a-z0-9][a-z0-9-]{0,63}$" });
export const SkillGroupSchema = Type.String({ pattern: "^group:[1-9][0-9]{0,19}$" });

/** 判断技能附件是否包含 npm 依赖清单与锁文件。 */
export function hasNpmLockFiles(files: Record<string, string>): boolean {
  return Object.hasOwn(files, "package.json") && Object.hasOwn(files, "package-lock.json");
}
