import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it } from "vitest";
import { DurableObjectSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { SandboxTasks, SANDBOX_TASK_SCHEMA, type SandboxSubject } from "../src/sandbox/task-access";

afterEach(reset);
const subject: SandboxSubject = { scope: "owner", actor: "10000001", owner: true, generation: 2, replyChannel: "qq" };
it("持久任务授权绑定不同输入，权限缩小、归档、撤销和绑定冲突不会产生新授权", async () => {
  await runInDurableObject(env.THREAD.getByName("owner"), async (_instance, state) => {
    const db = new DurableObjectSqliteDatabase(state.storage), tasks = new SandboxTasks(db);
    await db.exec(SANDBOX_TASK_SCHEMA);
    const input = { sourceInputId: "message:1", subject, workspace: "owner-workspace",
      permissions: { coding: true } };
    const task = await tasks.issue(input);
    expect(await tasks.issue(input)).toEqual(task);
    await db.run("UPDATE sandbox_tasks SET value=? WHERE id=?", JSON.stringify({
      ...task, permissions: { ...task.permissions, remote: { view: true, execute: false, control: true } },
    }), task.id);
    await tasks.bind("background:result", task.id);
    const resumed = new SandboxTasks(db);
    expect(await resumed.inputTask("background:result")).toBe(task.id);
    expect((await resumed.resolve(task.id, subject))?.permissions).toEqual({ coding: true });
    for (const changed of [{ actor: "other" }, { generation: 3 }, { owner: false }, { scope: "group:1" }, { replyChannel: "web" as const }]) {
      expect(await resumed.resolve(task.id, { ...subject, ...changed })).toBeUndefined();
    }
    const other = await tasks.issue({ ...input, sourceInputId: "message:2" });
    await expect(tasks.bind("background:result", other.id)).rejects.toThrow("binding_conflict");
    await tasks.revokeAll(["message:not-started"]);
    expect(await resumed.inputTask("message:not-started")).toBeNull();
    expect(await tasks.resolve(task.id, subject)).toBeUndefined();
    await expect(tasks.issue(input)).rejects.toThrow("revoked");
    await expect(tasks.issue({ ...input, sourceInputId: "message:not-started" })).rejects.toThrow("revoked");
    await expect(tasks.bind("late-result", task.id)).rejects.toThrow("revoked");
  });
});
