import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fauxProvider, fauxAssistantMessage, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { MODEL_PROVIDERS } from "../src/models";
import worker from "../src/index";
import { threadView } from "../src/admin/read-views";
import { input } from "./helpers";

afterEach(async () => { vi.restoreAllMocks(); await reset(); });
const owner = () => env.THREAD.getByName("owner");
function fake(handler: FauxResponseFactory) {
  const provider = fauxProvider({ models: [{ id: "test" }], tokensPerSecond: Infinity });
  const respond: FauxResponseFactory = async (...args) => { provider.setResponses([respond]); return handler(...args); };
  provider.setResponses([respond]);
  vi.spyOn(MODEL_PROVIDERS.faux, "create").mockReturnValue(provider.provider);
}
function request(path: string, method = "GET", body?: unknown) {
  return worker.fetch(new Request("https://test/admin/threads/owner/" + path, {
    method, headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), { ...env, ADMIN_TOKEN: "test" });
}
describe("session lifecycle", () => {
  it("archives the immutable transcript, resets context once, and preserves QQ history and memory", async () => {
    const contexts: string[] = [];
    fake(ctx => { contexts.push(JSON.stringify(ctx.messages)); return fauxAssistantMessage("已收到"); });
    await owner().submit(input(1, "重置前的海风代号", 10000001));
    const profile = (await owner().memoryView("owner", "")).profile;
    await owner().writeProfile("owner", "长期画像仍保留", profile.revision);
    const id = crypto.randomUUID();
    const first = await owner().resetSession("owner", id, "第一段对话");
    expect(first).toEqual({ status: "reset", generation: 1 });
    expect(await owner().resetSession("owner", id, "第一段对话")).toEqual(first);
    expect(await owner().resetSession("owner", id, "另一个名称")).toEqual({ error: "request_conflict" });
    await owner().submit(input(2, "新话题", 10000001));
    expect(contexts.at(-1)).not.toContain("重置前的海风代号");
    const history = await owner().sessionHistory("owner");
    expect(history.entries.filter(e => e.reset)).toHaveLength(1);
    expect(JSON.stringify(history.entries)).toContain("重置前的海风代号");
    expect((await owner().memoryView("owner", "")).profile.text).toBe("长期画像仍保留");
    await runInDurableObject(owner(), (_instance, state) => {
      expect(state.storage.sql.exec<{ n: number }>("SELECT count(*) n FROM messages").one().n).toBe(2);
    });
  });
  it("refuses reset during a run and paginates history without duplicates", async () => {
    let release!: () => void, started = false;
    const gate = new Promise<void>(r => { release = r; });
    fake(async () => { started = true; await gate; return fauxAssistantMessage("结束"); });
    const pending = owner().submit(input(3, "正在处理", 10000001));
    await expect.poll(() => started).toBe(true);
    expect(await owner().resetSession("owner", crypto.randomUUID(), "")).toEqual({ error: "busy" });
    release(); await pending;
    for (let i = 4; i < 24; i++) await owner().submit(input(i, "历史" + i, 10000001));
    await owner().syncAdminView("owner");
    const page = await threadView(env,"owner").sessionHistory("owner");
    expect(page.entries).toHaveLength(10);
    expect(page.next).toBeTruthy();
    const older = await threadView(env,"owner").sessionHistory("owner", page.next);
    expect(older.entries).toHaveLength(10);
    expect(older.entries.some(e => page.entries.some(p => p.id === e.id))).toBe(false);
    expect((await request("history?cursor=!!!")).status).toBe(400);
  });
  it("runs native compaction and records a reset receipt for recovery", async () => {
    fake(() => fauxAssistantMessage("这里是可保留的摘要"));
    await owner().submit(input(1, "测试压缩", 10000001));
    const response = await request("compact", "POST", {});
    expect(response.status).toBe(202);
    await expect.poll(async () => (await owner().sessionHistory("owner")).compacting).toBe(false);
    const id = crypto.randomUUID();
    await owner().resetSession("owner", id, "恢复演练");
    await runInDurableObject(owner(), (_instance, state) => {
      state.storage.sql.exec("UPDATE session_resets SET status='pending' WHERE request_id=?", id);
    });
    await owner().resetSession("owner", id, "恢复演练");
    expect((await owner().sessionHistory("owner")).entries.filter(e => e.reset)).toHaveLength(1);
  });
});
