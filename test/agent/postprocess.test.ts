import type { Models } from "@earendil-works/pi-ai";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { fitText, postprocessReply, QQ_TEXT_LIMIT, RELAY_PROMPT, sanitizeReply, stripMarkdown } from "../../src/agent/reply-postprocess.js";

const LONE_HIGH = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/;
const LONE_LOW = /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const FENCE = "`".repeat(3);

describe("fitText (UTF-16 code units, same rule as QQBridge)", () => {
  it("keeps short text", () => {
    expect(fitText("  你好  ")).toEqual({ text: "你好", truncated: false });
  });
  it("keeps text of exactly 4000 UTF-16 units (2000 emoji) untouched", () => {
    const text = "😀".repeat(2000);
    expect(fitText(text)).toEqual({ text, truncated: false });
  });
  it("truncates emoji text with a note, never splitting surrogate pairs", () => {
    for (const long of ["😀".repeat(5000), "a" + "😀".repeat(3000), "😀".repeat(2001)]) {
      const r = fitText(long);
      expect(r.truncated).toBe(true);
      expect(r.text.length).toBeLessThanOrEqual(QQ_TEXT_LIMIT);
      expect(r.text.endsWith("（内容过长，已截断）")).toBe(true);
      expect(r.text).not.toMatch(LONE_HIGH);
      expect(r.text).not.toMatch(LONE_LOW);
    }
  });
  it("lone high / low surrogates become U+FFFD before the cap (R11)", () => {
    expect(fitText("a\uD800b").text).toBe("a�b");
    expect(fitText("a\uDC00b").text).toBe("a�b");
    expect(fitText("\uDBFF").text).toBe("�");
    expect(fitText("😀\uDC00😀").text).toBe("😀�😀");
    const long = fitText("\uD800".repeat(5000));
    expect(long.truncated).toBe(true);
    expect(long.text.length).toBeLessThanOrEqual(QQ_TEXT_LIMIT);
    expect(long.text).not.toMatch(LONE_HIGH);
    expect(long.text).not.toMatch(LONE_LOW);
    expect(sanitizeReply("x\uDC01 @y")).toBe("x� ＠y");
  });
  it("empty text gets a placeholder", () => {
    expect(fitText("   ").text).toBe("（无内容）");
  });
});

describe("sanitize", () => {
  it("strips code fences (keeping their content), heading markers, bold and inline code", () => {
    const md = `# 标题\n## 小节\n正文 **加粗** 与 \`code\`\n${FENCE}ts\nconst a = 1;\n${FENCE}\n~~~\nx\n~~~`;
    expect(stripMarkdown(md)).toBe("标题\n小节\n正文 加粗 与 code\nconst a = 1;\nx");
  });

  it("turns tables into plain rows and drops separator lines", () => {
    const md = "| 队伍 | 比分 |\n|---|:---:|\n| NAVI | 2 |\n| FaZe | 1 |";
    expect(stripMarkdown(md)).toBe("队伍  比分\nNAVI  2\nFaZe  1");
  });

  it("never outputs @ and collapses extra blank lines", () => {
    const out = sanitizeReply("@全体成员 联系 a@b.com\n\n\n\n下一段");
    expect(out).not.toContain("@");
    expect(out).toBe("＠全体成员 联系 a＠b.com\n\n下一段");
  });

  it("caps at 4000 UTF-16 units without splitting surrogates", () => {
    const out = sanitizeReply("# h\n" + "😀".repeat(3000));
    expect(out.length).toBeLessThanOrEqual(4000);
    expect(out).not.toMatch(LONE_HIGH);
  });

  it("leaves a '#' inside text alone", () => {
    expect(stripMarkdown("编号#3 和 C#")).toBe("编号#3 和 C#");
  });
});

describe("relay / direct", () => {
  it("relay prompt is at most 5 lines", () => {
    expect(RELAY_PROMPT.split("\n").length).toBeLessThanOrEqual(5);
  });

  it("direct mode never calls a model", async () => {
    const models = {
      completeSimple: async () => {
        throw new Error("must not be called");
      },
    } as unknown as Models;
    const r = await postprocessReply("**hi** @x", { mode: "direct", models, model: {} as never });
    expect(r).toEqual({ text: "hi ＠x", relayed: false });
  });

  it("relay uses the faux model output (then sanitizes it)", async () => {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    let seenSystem = "";
    faux.setResponses([
      (context) => {
        seenSystem = JSON.stringify(context);
        return fauxAssistantMessage(fauxText("## 整理好了 @某人"));
      },
    ]);
    const r = await postprocessReply("# raw", { mode: "relay", models, model: faux.getModel() });
    expect(r).toEqual({ text: "整理好了 ＠某人", relayed: true });
    expect(seenSystem).toContain("整理成适合在 QQ 里直接显示的纯文本");
  });

  it("relay error, empty output or timeout falls back to sanitize only", async () => {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage([], { stopReason: "error", errorMessage: "rate limited" }), fauxAssistantMessage(fauxText("   "))]);
    expect(await postprocessReply("**a**", { mode: "relay", models, model: faux.getModel() })).toEqual({ text: "a", relayed: false });
    expect(await postprocessReply("**b**", { mode: "relay", models, model: faux.getModel() })).toEqual({ text: "b", relayed: false });

    const hanging = {
      completeSimple: (_m: unknown, _c: unknown, o: { signal: AbortSignal }) =>
        new Promise((_r, reject) => o.signal.addEventListener("abort", () => reject(new Error("aborted")))),
    } as unknown as Models;
    const started = Date.now();
    expect(await postprocessReply("**c**", { mode: "relay", models: hanging, model: {} as never, timeoutMs: 50 })).toEqual({ text: "c", relayed: false });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("relay without a configured model sanitizes only", async () => {
    expect(await postprocessReply("`x`", { mode: "relay" })).toEqual({ text: "x", relayed: false });
  });
});
