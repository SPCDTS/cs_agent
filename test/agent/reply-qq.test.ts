import { describe, expect, it } from "vitest";
import { createReplyQQTool, fitText, QQ_TEXT_LIMIT } from "../../src/agent/tools/reply-qq.js";

describe("fitText", () => {
  it("keeps short text", () => {
    expect(fitText("  你好  ")).toEqual({ text: "你好", truncated: false });
  });
  it("truncates to ≤4000 code points with a note, never splitting surrogate pairs", () => {
    const long = "😀".repeat(5000);
    const r = fitText(long);
    expect(r.truncated).toBe(true);
    expect(Array.from(r.text).length).toBeLessThanOrEqual(QQ_TEXT_LIMIT);
    expect(r.text.endsWith("（内容过长，已截断）")).toBe(true);
    expect(r.text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
  it("empty text gets a placeholder", () => {
    expect(fitText("   ").text).toBe("（无内容）");
  });
});

describe("reply_qq tool", () => {
  it("reads ticket from the conversation doc, sends truncated text, returns terminate", async () => {
    const sent: unknown[] = [];
    const tool = createReplyQQTool(() => ({
      reply: async (ticket: string, text: string, images?: string[]) => {
        sent.push({ ticket, len: Array.from(text).length, images });
        return { already_sent: false, message_id: "9", message_type: "group" as const, target_id: "g" };
      },
    }));
    const api = {
      conversationId: 7,
      snapshot: async () => ({ ticket: "tkt", source: {}, text: "" }),
    } as any;
    const result = await tool.execute({ text: "x".repeat(5000), image_paths: ["/a.png"] }, api, {} as any);
    expect(sent).toEqual([{ ticket: "tkt", len: 4000, images: ["/a.png"] }]);
    expect(result.control).toEqual({ terminate: true });
    expect(JSON.stringify(result.output)).toContain("截断");
  });

  it("fails without a bound ticket", async () => {
    const tool = createReplyQQTool(() => ({ reply: async () => ({}) as any }));
    const api = { conversationId: 1, snapshot: async () => undefined } as any;
    await expect(tool.execute({ text: "hi" }, api, {} as any)).rejects.toThrow(/票据/);
  });
});
