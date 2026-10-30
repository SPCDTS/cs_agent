import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { DurableObjectSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { normalizeMessage, normalizeNotice } from "../src/policy";
import { parseFrame } from "../src/onebot";
import { recallMedia, markMessageRecalled, recall } from "../src/context";
import { event } from "./helpers";
afterEach(async () => { await reset(); });
describe("QQ媒体上下文", () => {
  it("保留各类媒体引用", () => {
    const input = normalizeMessage({ ...event(1), message: [
      { type: "image", data: { url: "https://cdn.example.com/a", file: "a.image", file_id: "i" } },
      { type: "file", data: { file_id: "f", name: "报告.pdf", file_size: 24 } },
      { type: "record", data: { url: "https://cdn.example.com/b" } },
      { type: "video", data: { file: "https://cdn.example.com/c" } },
    ] });
    expect(input?.media).toEqual([
      { kind: "image", ordinal: 1, url: "https://cdn.example.com/a", file: "a.image", fileId: "i" },
      { kind: "file", ordinal: 2, fileId: "f", name: "报告.pdf", size: 24 },
      { kind: "audio", ordinal: 3, url: "https://cdn.example.com/b" },
      { kind: "video", ordinal: 4, file: "https://cdn.example.com/c" },
    ]);
  });
  it("上传与撤回notice独立归一化", () => {
    const base = { post_type: "notice", self_id: 10000000, user_id: 10000003, group_id: 200000001, time: 5 };
    const upload = normalizeNotice({ ...base, notice_type: "group_upload", file: { id: "file-1", name: "报告.pdf", size: 12 } });
    expect(upload).toMatchObject({ kind: "upload", input: { routeText: "", media: [{ kind: "file", fileId: "file-1", name: "报告.pdf" }] } });
    expect(parseFrame(JSON.stringify({ ...base, notice_type: "group_recall", message_id: 8 }))).toEqual({ kind: "notice", notice: {
      kind: "recall", messageId: "8", selfId: "10000000", userId: "10000003", time: 5, target: { kind: "group", groupId: "200000001" },
    } });
  });
  it("历史引用按scope召回，撤回后停止召回并保留标注", async () => {
    const input = normalizeMessage({ ...event(1), message: [{ type: "image", data: { url: "https://cdn.example.com/a" } }] });
    if (!input) throw new Error("fixture");
    const thread = env.THREAD.getByName("private:10000003");
    await thread.ingest(input);
    const result = await runInDurableObject(thread, async (_instance, state) => {
      const database = new DurableObjectSqliteDatabase(state.storage);
      const own = await recallMedia(database, "private:10000003", "1"), other = await recallMedia(database, "group:200000001", "1");
      const before = await recall(database, "private:10000003", {});
      await markMessageRecalled(database, "private:10000003", "1");
      let denied = false;
      try { await recallMedia(database, "private:10000003", "1"); } catch { denied = true; }
      return { own, other, before, denied, after: await recall(database, "private:10000003", {}) };
    });
    expect(result.own).toHaveLength(1); expect(result.other).toEqual([]);
    expect(result.before).toContain("message_id:1"); expect(result.denied).toBe(true); expect(result.after).toContain("已撤回");
  });
});
