import { describe, expect, it } from "vitest";
import { buildMime, messageSchema, renderMessage, type SendInput } from "../../../src/sidecar/gmail/mime.js";

const input: SendInput = { to: "收件人 <to@example.com>", cc: "copy@example.com", bcc: "hidden@example.com", subject: "中文主题", body: "正文\n".repeat(80), idempotency_key: "send-test-1" };

describe("Gmail MIME 与正文", () => {
  it("构造 UTF-8 主题、显示名、To/Cc/Bcc 与每行 76 字符的 base64 正文", () => {
    const mime = buildMime(input);
    const [headers, encoded] = mime.split("\r\n\r\n");
    expect(headers).toContain(`Subject: =?UTF-8?B?${Buffer.from(input.subject).toString("base64")}?=`);
    expect(headers).toContain(`To: =?UTF-8?B?${Buffer.from("收件人").toString("base64")}?= <to@example.com>`);
    expect(headers).toContain("Cc: copy@example.com\r\nBcc: hidden@example.com");
    expect(headers).toContain("MIME-Version: 1.0");
    expect(headers).toContain("Content-Type: text/plain; charset=UTF-8");
    expect(headers).toContain("Content-Transfer-Encoding: base64");
    expect(headers).not.toMatch(/^From:/mu);
    const lines = encoded.trim().split("\r\n");
    expect(lines.slice(0, -1).every(line => line.length === 76)).toBe(true);
    expect(Buffer.from(encoded, "base64").toString("utf8")).toBe(input.body);
    expect(mime.replace(/\r\n/gu, "")).not.toContain("\n");
  });

  it("回复保留 Message-ID、References 并在空主题时加 Re 前缀", () => {
    const mime = buildMime({ ...input, subject: "" }, { messageId: "<reply@example.com>", references: "<root@example.com>", subject: "original" });
    expect(mime).toContain("Subject: Re: original\r\n");
    expect(mime).toContain("In-Reply-To: <reply@example.com>\r\nReferences: <root@example.com>\r\n <reply@example.com>");
  });

  it.each(["to", "cc", "bcc", "subject", "reply_to_message_id"])("拒绝 %s 的 CRLF 注入", field => {
    expect(() => buildMime({ ...input, [field]: "victim@example.com\r\nBcc: other@example.com" })).toThrow("头部");
  });

  it.each(["local@localhost", "missing-at.example.com", "a@example.com,", "a..b@example.com", "name <a@-bad.example>"])("拒绝非法地址 %s", to => {
    expect(() => buildMime({ ...input, to })).toThrow("地址无效");
  });

  it("不把纯文本附件当作正文，multipart/alternative 优先 plain", () => {
    const message = messageSchema.parse({ id: "one", threadId: "thread", payload: { mimeType: "multipart/mixed", parts: [
      { mimeType: "multipart/alternative", parts: [
        { mimeType: "text/html", body: { data: Buffer.from("<p>HTML 版本</p>").toString("base64url") } },
        { mimeType: "text/plain", body: { data: Buffer.from("纯文本正文").toString("base64url") } },
      ] },
      { filename: "notes.txt", mimeType: "text/plain", body: { data: Buffer.from("附件内容不可显示").toString("base64url"), size: 27 } },
      { filename: "report.pdf", mimeType: "application/pdf", body: { attachmentId: "attachment-1", size: 1234 } },
    ] } });
    const text = renderMessage(message);
    expect(text).toContain("纯文本正文");
    expect(text).not.toContain("HTML 版本");
    expect(text).not.toContain("附件内容不可显示");
    expect(text).toContain("notes.txt | text/plain | 27 bytes");
    expect(text).toContain("report.pdf | application/pdf | 1234 bytes");
  });

  it("仅 HTML 时去标签、脚本并解码常见及数字实体", () => {
    const text = renderMessage(messageSchema.parse({ id: "one", threadId: "thread", payload: { mimeType: "text/html", body: {
      data: Buffer.from("<style>hidden</style><p>Hello&nbsp;&amp; &#x4e2d;&#25991;</p><script>hidden()</script>").toString("base64url"),
    } } }));
    expect(text).toContain("Hello & 中文");
    expect(text).not.toContain("hidden");
    expect(text).not.toContain("<p>");
  });

  it("按 UTF-8 字节截断正文，标注原始大小且不切坏字符", () => {
    const text = renderMessage(messageSchema.parse({ id: "one", threadId: "thread", payload: { mimeType: "text/plain", body: {
      data: Buffer.from("中".repeat(12000)).toString("base64url"),
    } } }));
    expect(text).toContain("[正文已截断，原始 36000 字节]");
    expect(text).not.toContain("\ufffd");
    expect(Buffer.byteLength(text)).toBeLessThan(33 * 1024);
  });
});
