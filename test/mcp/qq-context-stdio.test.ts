/** 构建后的 dist/mcp/qq-context.js 真实 stdio 子进程冒烟（集成项目）：环境变量接线、只读打开库、召回归属落库。 */
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { expect, it } from "vitest";
import { ContextStore } from "../../src/context/store.js";
import { tmp } from "../agent/helpers.js";
import { connect, msg, scope, textOf } from "./qq-context-fixture.js";

it("stdio 子进程按线程令牌求范围，只读打开消息库并写入召回归属", async () => {
  const dir = tmp();
  const writer = new ContextStore(dir);
  writer.ingest(msg("本群历史", { message_id: "700" }));
  writer.ingest(msg("别群历史", { message_id: "701", group_id: "39999" }));
  writer.close();
  const { client, revoke } = await connect(dir, scope, { stdio: true });
  expect((await client.listTools()).tools.map(t => t.name).sort()).toEqual(["qq_chats", "qq_image", "qq_message", "qq_recent", "qq_search", "qq_view_image"]);
  const recent = textOf(await client.callTool({ name: "qq_recent", arguments: {} }));
  expect(recent).toContain("本群历史");
  expect(recent).not.toContain("别群历史");
  const db = new DatabaseSync(path.join(dir, "observability.sqlite"), { readOnly: true });
  try { expect(db.prepare("SELECT * FROM recall_events").get()).toMatchObject({ backend: "codex", turn_id: "codex:mcp-turn", session: "thr-sess" }); }
  finally { db.close(); }
  revoke();
  expect((await client.callTool({ name: "qq_recent", arguments: {} })).isError).toBe(true);
});
