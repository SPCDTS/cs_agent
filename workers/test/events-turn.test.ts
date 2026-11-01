import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadDO } from "../src/thread";
import { DEFAULT_SETTINGS } from "../src/events/model";
import { fakeGoogle, scriptedModel, sql } from "./events-helpers";
import { action, connect, input, reply } from "./helpers";

const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  vi.restoreAllMocks();
  await reset();
});
const events = () => env.EVENTS.getByName("main");
const status = async () => (await sql<{ status: string }>("SELECT status FROM event_run"))[0]?.status;
const inboundRow = (key: string) => runInDurableObject(env.THREAD.getByName("owner"), (_instance, state) =>
  state.storage.sql.exec<{ status: string; when_busy: string | null }>("SELECT status, when_busy FROM inbound WHERE message_id = ?", key).toArray()[0]);
async function deliverMail(google: ReturnType<typeof fakeGoogle>, id: string) {
  await events().poll("gmail");
  await events().putSettings("gmail", { ...DEFAULT_SETTINGS, mergeWindowS: 0 });
  google.addMail(id, { subject: "Q4 预算确认", body: "请在周五前确认预算。" });
  await events().notify("gmail");
}
const EVENT_TOOLS = ["send_message", "qq_context", "mem_search", "gmail_search", "gmail_read", "web_search", "web_page", "read_skill"];
const WRITE_TOOLS = ["mem_remember", "mem_update", "mem_forget", "mem_profile", "gmail_send"];
const SANDBOX_TOOLS = ["read", "write", "edit", "bash"];

describe("event turns in the owner thread", () => {
  it("runs a read-only triage turn, records sent, and restores the full tool set for the next owner message", async () => {
    const { socket, frames } = await connect(sockets);
    const google = fakeGoogle();
    const seen = scriptedModel([
      { name: "gmail_read", args: { id: "a" } },
      { name: "gmail_send", args: { to: "bob@example.test", subject: "x", text: "y", idempotencyKey: "event-attempt-1" } },
      { name: "send_message", args: { text: "有一封预算确认邮件需要你周五前处理。" } },
      { name: "", args: {} },
      { name: "mem_search", args: {} },
    ]);
    await deliverMail(google, "a");
    reply(socket, (await action(frames, 0, "send_private_msg")).echo);
    await vi.waitFor(async () => expect(await status()).toBe("sent"), { timeout: 10_000 });

    const first = seen.requests[0]!;
    expect(first.user).toContain("[外部事件] gmail · 新邮件 1 件");
    expect(first.tools).toEqual(expect.arrayContaining(EVENT_TOOLS));
    for (const name of [...WRITE_TOOLS, ...SANDBOX_TOOLS, "generate_image"]) expect(first.tools).not.toContain(name);
    expect(seen.outputs[0]).toContain("请在周五前确认预算。");
    expect(seen.outputs[0]).toContain("report.pdf | 2048 bytes");
    expect(google.state.sends).toBe(0);
    expect(seen.outputs[1]).not.toContain("已发送");

    expect(await env.THREAD.getByName("owner").submit(input(2, "好的，记一下", 10000001))).toEqual({ status: "done" });
    const chat = seen.requests.find(request => request.user.includes("好的，记一下"));
    expect(chat?.tools).toEqual(expect.arrayContaining([...EVENT_TOOLS, ...WRITE_TOOLS, "codemode"]));
    for (const name of SANDBOX_TOOLS) expect(chat?.tools).not.toContain(name);
    expect(chat?.tools).not.toContain("generate_image");
    const messages = await runInDurableObject(env.THREAD.getByName("owner"), (_instance, state) =>
      state.storage.sql.exec<{ text: string }>("SELECT text FROM messages").toArray().map(row => row.text).join("\n"));
    expect(messages).not.toContain("Q4 预算确认");
  });

  it("queues an event behind the running owner turn instead of steering into it", async () => {
    const { socket, frames } = await connect(sockets);
    const google = fakeGoogle();
    const seen = scriptedModel([{ name: "send_message", args: { text: "处理中" } }, { name: "", args: {} }]);
    const turn = env.THREAD.getByName("owner").submit(input(3, "帮我看看", 10000001));
    const held = await action(frames, 0, "send_private_msg");
    await deliverMail(google, "late");
    const [run] = await sql<{ input_key: string }>("SELECT input_key FROM event_run");
    expect(await inboundRow(run!.input_key)).toEqual({ status: "queued", when_busy: null });

    reply(socket, held.echo);
    expect(await turn).toEqual({ status: "done" });
    await vi.waitFor(async () => expect(await status()).toBe("silent"), { timeout: 10_000 });
    expect(await inboundRow(run!.input_key)).toEqual({ status: "done", when_busy: "followUp" });
    const event = seen.requests.find(request => request.user.includes("[外部事件]"));
    expect(event?.tools).not.toContain("mem_remember");
  });
});

describe("Gmail tools", () => {
  it("searches, then sends once per idempotencyKey in an owner message turn", async () => {
    const google = fakeGoogle();
    google.addMail("budget-1", { subject: "预算\n确认", snippet: "请确认" });
    const draft = { to: "Bob <bob@example.test>", subject: "回复：预算", text: "已确认。", inReplyTo: "budget-1", idempotencyKey: "reply-budget-0001" };
    const seen = scriptedModel([{ name: "gmail_search", args: { q: "预算", maxResults: 5 } }, { name: "gmail_send", args: draft }, { name: "gmail_send", args: draft }]);
    expect(await env.THREAD.getByName("owner").submit(input(4, "回他已确认", 10000001))).toEqual({ status: "done" });
    expect(seen.outputs[0]).toBe("budget-1 | Tue, 27 Oct 2026 08:18:00 +0000 | Alice <alice@example.test> | 预算 确认\n  请确认");
    expect(google.state.sends).toBe(1);
    expect(seen.outputs[1]).toContain("已发送 messageId=sent-1");
    expect(seen.outputs[2]).toContain("未再次发送");
    expect(await sql("SELECT key, message_id FROM gmail_send_receipts")).toEqual([{ key: draft.idempotencyKey, message_id: "sent-1" }]);
  });

  it.each([
    { ns: "group:200000001", value: input(5, "查邮件", 10000003, 200000001, true) },
    { ns: "private:10000003", value: input(6, "查邮件", 10000003) },
  ])("does not offer Gmail tools in $ns", async ({ ns, value }) => {
    fakeGoogle();
    const seen = scriptedModel([]);
    await runInDurableObject(env.THREAD.getByName(ns), async (_instance, state) => {
      expect(await new ThreadDO(state, { ...env, MEMORY_EXTRACT_NAMESPACES: "" }).submit(value)).toEqual({ status: "done" });
    });
    expect(seen.requests[0]?.tools.some(name => name.startsWith("gmail_"))).toBe(false);
  });
});
