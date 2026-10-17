import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createReplyQQTool, fitText, QQ_TEXT_LIMIT, resolveReplyImages } from "../../src/agent/tools/reply-qq.js";

const LONE_HIGH = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/;
const LONE_LOW = /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe("fitText (UTF-16 code units, same rule as QQBridge)", () => {
  it("keeps short text", () => {
    expect(fitText("  你好  ")).toEqual({ text: "你好", truncated: false });
  });
  it("keeps text of exactly 4000 UTF-16 units (2000 emoji) untouched", () => {
    const text = "😀".repeat(2000);
    expect(fitText(text)).toEqual({ text, truncated: false });
  });
  it("2001 emoji (4002 units, 2001 code points) is truncated to ≤4000 units", () => {
    const r = fitText("😀".repeat(2001));
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(QQ_TEXT_LIMIT);
  });
  it("truncates emoji text with a note, never splitting surrogate pairs", () => {
    for (const long of ["😀".repeat(5000), "a" + "😀".repeat(3000)]) {
      const r = fitText(long);
      expect(r.truncated).toBe(true);
      expect(r.text.length).toBeLessThanOrEqual(QQ_TEXT_LIMIT);
      expect(r.text.endsWith("（内容过长，已截断）")).toBe(true);
      expect(r.text).not.toMatch(LONE_HIGH);
      expect(r.text).not.toMatch(LONE_LOW);
    }
  });
  it("empty text gets a placeholder", () => {
    expect(fitText("   ").text).toBe("（无内容）");
  });
});

let imagesDir: string;
beforeEach(() => {
  imagesDir = mkdtempSync(path.join(tmpdir(), "reply-img-"));
});
afterEach(() => rmSync(imagesDir, { recursive: true, force: true }));

function makeImage(ticket: string, name = "out.png"): string {
  const dir = path.join(imagesDir, ticket);
  mkdirSync(dir, { recursive: true });
  const f = path.join(dir, name);
  writeFileSync(f, "png");
  return f;
}

describe("resolveReplyImages", () => {
  it("accepts recorded images under the ticket dir and returns realpaths", async () => {
    const f = makeImage("tkt");
    await expect(resolveReplyImages([f], imagesDir, "tkt", [realpathSync(f)])).resolves.toEqual([realpathSync(f)]);
  });
  it("rejects images when nothing was recorded", async () => {
    const f = makeImage("tkt");
    await expect(resolveReplyImages([f], imagesDir, "tkt", undefined)).rejects.toThrow(/generate_image/);
  });
  it("rejects another ticket's image even if recorded", async () => {
    const other = makeImage("other");
    makeImage("tkt");
    await expect(resolveReplyImages([other], imagesDir, "tkt", [realpathSync(other)])).rejects.toThrow(/不合法/);
  });
  it("rejects unrecorded files in the ticket dir, missing files and outside paths", async () => {
    const f = makeImage("tkt");
    const extra = makeImage("tkt", "extra.png");
    const rec = [realpathSync(f)];
    await expect(resolveReplyImages([extra], imagesDir, "tkt", rec)).rejects.toThrow(/不合法/);
    await expect(
      resolveReplyImages([path.join(imagesDir, "tkt", "..", "tkt", "missing.png")], imagesDir, "tkt", rec),
    ).rejects.toThrow(/不合法/);
    await expect(resolveReplyImages([path.join(imagesDir, "..")], imagesDir, "tkt", rec)).rejects.toThrow(/不合法/);
  });
  it("no paths → no images, no check", async () => {
    await expect(resolveReplyImages([], imagesDir, "tkt", undefined)).resolves.toEqual([]);
  });
});

describe("reply_qq tool", () => {
  it("reads ticket from the conversation doc, sends truncated text, returns terminate", async () => {
    const sent: unknown[] = [];
    const tool = createReplyQQTool(
      () => ({
        reply: async (ticket: string, text: string, images?: string[]) => {
          sent.push({ ticket, len: text.length, images });
          return { already_sent: false, message_id: "9", message_type: "group" as const, target_id: "g" };
        },
      }),
      imagesDir,
    );
    const f = makeImage("tkt");
    const api = {
      conversationId: 7,
      snapshot: async () => ({ ticket: "tkt", source: {}, text: "", images: [realpathSync(f)] }),
    } as any;
    const result = await tool.execute({ text: "x".repeat(5000), image_paths: [f] }, api, {} as any);
    expect(sent).toEqual([{ ticket: "tkt", len: 4000, images: [realpathSync(f)] }]);
    expect(result.control).toEqual({ terminate: true });
    expect(JSON.stringify(result.output)).toContain("截断");
  });

  it("rejects a foreign image path without sending and without terminating", async () => {
    let calls = 0;
    const tool = createReplyQQTool(
      () => ({
        reply: async () => {
          calls++;
          return {} as any;
        },
      }),
      imagesDir,
    );
    const api = { conversationId: 1, snapshot: async () => ({ ticket: "tkt", source: {}, text: "" }) } as any;
    const result = await tool.execute({ text: "hi", image_paths: ["/data/images/x/secret.png"] }, api, {} as any);
    expect(calls).toBe(0);
    expect(result.isError).toBe(true);
    expect(result.control).toBeUndefined();
    expect(JSON.stringify(result.output)).toContain("generate_image");
  });

  it("fails without a bound ticket", async () => {
    const tool = createReplyQQTool(() => ({ reply: async () => ({}) as any }), imagesDir);
    const api = { conversationId: 1, snapshot: async () => undefined } as any;
    await expect(tool.execute({ text: "hi" }, api, {} as any)).rejects.toThrow(/票据/);
  });
});
