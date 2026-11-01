import { Type, type Static } from "typebox";
import type { DurableObjectSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { parse } from "../../../runner/src/protocol";

export type RemoteAction = "view" | "execute" | "control";
const SubjectSchema = Type.Object({ scope: Type.String(), actor: Type.String(), generation: Type.Integer(),
  replyChannel: Type.Union([Type.Literal("qq"), Type.Literal("web")]), owner: Type.Boolean() }, { additionalProperties: false });
const PermissionsSchema = Type.Object({ coding: Type.Boolean(), remote: Type.Object({ view: Type.Boolean(), execute: Type.Boolean(), control: Type.Boolean() }) });
const TaskSchema = Type.Object({ id: Type.String(), sourceInputId: Type.String(), subject: SubjectSchema, workspace: Type.String(),
  permissions: PermissionsSchema, createdAt: Type.Number() }, { additionalProperties: false });
export type SandboxTask = Static<typeof TaskSchema>;
export type SandboxSubject = Static<typeof SubjectSchema>;
export const SANDBOX_TASK_SCHEMA = `
CREATE TABLE IF NOT EXISTS sandbox_tasks (id TEXT PRIMARY KEY, source_input_id TEXT NOT NULL UNIQUE, value TEXT NOT NULL, revoked_at INTEGER);
CREATE TABLE IF NOT EXISTS sandbox_task_inputs (input_id TEXT PRIMARY KEY, task_id TEXT);
`;

/** 授权记录属于任务；输入只是绑定，回合种类不参与已签发授权的使用检查。 */
export class SandboxTasks {
  constructor(private readonly db: DurableObjectSqliteDatabase) {}
  async issue(input: Omit<SandboxTask, "id" | "createdAt">): Promise<SandboxTask> {
    return this.db.transaction(async tx => {
      const binding = await tx.get<{ task_id: string | null }>("SELECT task_id FROM sandbox_task_inputs WHERE input_id=?", input.sourceInputId);
      if (binding?.task_id === null) throw new Error("sandbox_task_revoked");
      const task = parse(TaskSchema, { ...input, id: crypto.randomUUID(), createdAt: Date.now() });
      await tx.run("INSERT OR IGNORE INTO sandbox_tasks(id,source_input_id,value) VALUES(?,?,?)", task.id, input.sourceInputId, JSON.stringify(task));
      const row = await tx.get<{ value: string; revoked_at: number | null }>("SELECT value,revoked_at FROM sandbox_tasks WHERE source_input_id=?", input.sourceInputId);
      if (!row) throw new Error("sandbox_task_missing");
      if (row.revoked_at !== null) throw new Error("sandbox_task_revoked");
      const saved = parse(TaskSchema, JSON.parse(row.value));
      if (binding && binding.task_id !== saved.id) throw new Error("sandbox_task_binding_conflict");
      await tx.run("INSERT OR IGNORE INTO sandbox_task_inputs(input_id,task_id) VALUES(?,?)", input.sourceInputId, saved.id);
      return saved;
    });
  }
  async bind(inputId: string, taskId: string): Promise<void> {
    await this.db.transaction(async tx => {
      if (!await tx.get("SELECT 1 FROM sandbox_tasks WHERE id=? AND revoked_at IS NULL", taskId)) throw new Error("sandbox_task_revoked");
      await tx.run("INSERT OR IGNORE INTO sandbox_task_inputs(input_id,task_id) VALUES(?,?)", inputId, taskId);
      const row = await tx.get<{ task_id: string }>("SELECT task_id FROM sandbox_task_inputs WHERE input_id=?", inputId);
      if (row?.task_id !== taskId) throw new Error("sandbox_task_binding_conflict");
    });
  }
  async inputTask(inputId: string): Promise<string | null | undefined> {
    return (await this.db.get<{ task_id: string | null }>("SELECT task_id FROM sandbox_task_inputs WHERE input_id=?", inputId))?.task_id;
  }
  async resolve(id: string, subject: SandboxSubject): Promise<SandboxTask | undefined> {
    const row = await this.db.get<{ value: string }>("SELECT value FROM sandbox_tasks WHERE id=? AND revoked_at IS NULL", id);
    if (!row) return;
    const task = parse(TaskSchema, JSON.parse(row.value)), original = task.subject;
    if (original.scope !== subject.scope || original.actor !== subject.actor || original.generation !== subject.generation
      || original.replyChannel !== subject.replyChannel || original.owner !== subject.owner) return;
    return task;
  }
  async revokeAll(pendingInputs: string[] = []): Promise<void> {
    await this.db.transaction(async tx => {
      await tx.run("UPDATE sandbox_tasks SET revoked_at=? WHERE revoked_at IS NULL", Date.now());
      for (const input of pendingInputs) await tx.run("INSERT OR IGNORE INTO sandbox_task_inputs(input_id,task_id) VALUES(?,NULL)", input);
    });
  }
}
