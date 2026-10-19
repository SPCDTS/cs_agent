import { describe, expect, it } from "vitest";
import { fitReply, fitText, postprocessReply, QQ_TEXT_LIMIT } from "../../src/agent/reply-postprocess.js";

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
    expect(fitReply("x\uDC01 @y")).toBe("x� @y");
  });
  it("empty text gets a placeholder", () => {
    expect(fitText("   ").text).toBe("（无内容）");
  });
});

describe("postprocessReply", () => {
  it("原文照发：Markdown、@ 与空行都不改动", () => {
    const md = `# 标题\n**加粗** 与 \`code\` __init__\n${FENCE}ts\nconst a = 1;\n${FENCE}\n| 队伍 | 比分 |\n|---|---|\n\n\n\n＠ @全体成员 a@b.com`;
    expect(postprocessReply(md)).toBe(md);
  });

  it("仍只做发送保护：去首尾空白、空文本占位、超长截断不拆代理对", () => {
    expect(postprocessReply("  # 原文  \n")).toBe("# 原文");
    expect(postprocessReply("")).toBe("（无内容）");
    const out = postprocessReply("# h\n" + "😀".repeat(3000));
    expect(out.length).toBeLessThanOrEqual(QQ_TEXT_LIMIT);
    expect(out.startsWith("# h\n")).toBe(true);
    expect(out).not.toMatch(LONE_HIGH);
  });
});
