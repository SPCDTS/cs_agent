import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { DurableObjectSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { fauxProvider, fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { MODEL_PROVIDERS } from "../src/models";
import { normalizeMessage } from "../src/policy";
import { markMessageRecalled, recall, withReplyContext } from "../src/context";
import { event, input } from "./helpers";

afterEach(async () => { vi.restoreAllMocks(); await reset(); });
function quotedInput() {
  const message = normalizeMessage({ ...event(2, "1", 10000001), message: [
    { type: "reply", data: { id: 1 } }, { type: "text", data: { text: "1" } },
  ] });
  if (!message) throw new Error("invalid_fixture");
  return message;
}

it.each(["文字", "图片"])("%s引用进入真实Thread回合，qq_context可按ID读原文", async kind => {
  const body = "这是一条完整原消息。".repeat(20) + "尾部重点";
  const original = normalizeMessage({ ...event(1, body, 10000001), ...(kind === "图片" ? {
    message: [{ type: "image", data: { url: "https://multimedia.nt.qq.com.cn/image.png" } }],
  } : {}) });
  if (!original) throw new Error("invalid_fixture");
  const thread = env.THREAD.getByName("owner");
  await thread.ingest(input(1, "另一个私聊的正文", 10000002));
  await thread.ingest(original);
  let modelInput = "", toolResult = "";
  const faux = fauxProvider({ models: [{ id: "test" }], tokensPerSecond: Infinity });
  const respond: FauxResponseFactory = async ctx => {
    faux.setResponses([respond]);
    const last = ctx.messages.at(-1);
    if (last?.role === "toolResult") {
      toolResult = JSON.stringify(last.content);
      return fauxAssistantMessage("done");
    }
    const user = ctx.messages.findLast(message => message.role === "user");
    modelInput = typeof user?.content === "string" ? user.content : JSON.stringify(user?.content);
    return fauxAssistantMessage(fauxToolCall("qq_context", { message_id: "2" }), { stopReason: "toolUse" });
  };
  faux.setResponses([respond]);
  vi.spyOn(MODEL_PROVIDERS.faux, "create").mockReturnValue(faux.provider);
  expect(await thread.submit(quotedInput())).toEqual({ status: "done" });
  expect(modelInput).toContain('[引用消息（同一QQ会话）]');
  expect(modelInput).toContain('"message_id":"1"');
  expect(modelInput).toContain(kind === "文字" ? body : '"text":"[image]"');
  expect(modelInput).toContain('[当前消息]\n[reply]1');
  expect(modelInput).not.toContain("另一个私聊的正文");
  expect(toolResult).toContain(kind === "文字" ? "尾部重点" : "[image]");
  expect(toolResult).toContain("[message_id:2]");
  await runInDurableObject(thread, async (_instance, state) => {
    const db = new DurableObjectSqliteDatabase(state.storage);
    expect(await recall(db, "private:10000001", { limit: 1 })).toContain("[reply_to_id:1]");
    expect(await db.get("SELECT text FROM messages WHERE scope=? AND message_id=?", "private:10000001", "2")).toEqual({ text: "[reply]1" });
  });
});

it("原消息未保存或已撤回时明确标注，不带出其他私聊原文", async () => {
  const thread = env.THREAD.getByName("owner");
  await thread.ingest(input(1, "另一个私聊的正文", 10000002));
  await thread.ingest(quotedInput());
  await runInDurableObject(thread, async (_instance, state) => {
    const db = new DurableObjectSqliteDatabase(state.storage);
    const text = await withReplyContext(db, "private:10000001", "2", "[reply]1");
    expect(text).toContain("原消息未保存在当前会话中");
    expect(text).not.toContain("另一个私聊的正文");
  });
  await thread.ingest(input(1, "撤回前的正文", 10000001));
  await runInDurableObject(thread, async (_instance, state) => {
    const db = new DurableObjectSqliteDatabase(state.storage);
    await markMessageRecalled(db, "private:10000001", "1");
    const text = await withReplyContext(db, "private:10000001", "2", "[reply]1");
    expect(text).toContain("原消息已撤回");
    expect(text).not.toContain("撤回前的正文");
    expect(await recall(db, "private:10000001", { message_id: "1" })).toBe("[message_id:1 已撤回]");
  });
});
