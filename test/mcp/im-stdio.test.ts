/** 构建后的 dist/mcp/im.js 真实 stdio 子进程冒烟（集成项目）；其余 im 行为在进程内覆盖（im.test.ts 等）。 */
import { expect, it } from "vitest";
import { imSendRig } from "./im-fixture.js";

it("独立 im stdio 工具立即发消息与附件，返回 message_id；工具清单固定为全集；qq_context 不再发送", async () => {
  const f = await imSendRig({ stdio: true });
  const tools = (await f.client.listTools()).tools;
  expect(tools.map(t => t.name)).toContain("send_message");
  expect(tools.map(t => t.name)).toEqual(expect.arrayContaining(["auth_grant", "auth_list", "schedule_create", "schedule_control"]));
  expect(Object.hasOwn(tools[0]!.inputSchema.properties!, "target")).toBe(true);
  const result = await f.tool("send_message", { text: "报告", images: ["image.png"], files: [{ path: "file.txt", name: "报告.txt" }] });
  expect(result.isError).not.toBe(true);
  expect(JSON.parse((result.content as { text: string }[])[0]!.text)).toMatchObject({ message_id: "1" });
  expect(f.call.mock.calls.map(c => c[0])).toEqual(["get_login_info", "send_group_msg", "upload_group_file"]);
  expect(f.store.listOutboxByTurn("t1").map(row => row.key)).toEqual([`${f.threadKey}:exec-1`]);
  const old = await f.tool("qq_send_file", { path: "file.txt" });
  expect(old.isError).toBe(true);
});
