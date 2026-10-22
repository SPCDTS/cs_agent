import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => vi.resetModules());
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("临时秘密生命周期与长期容量", () => {
  it("工具正文中的凭据值按完整引号值或整条认证头隐藏", async () => {
    const { redactText } = await import("../../src/shared/redact.js");
    for (const key of ['password', 'passwd', 'cookie', 'credential', 'credentials', 'api_key', 'authorization']) {
      expect(redactText(JSON.stringify({ [key]: 'first second \\" third' }))).not.toMatch(/first|second|third/);
      expect(redactText(`${key}='first second third'`)).not.toMatch(/first|second|third/);
    }
    for (const header of ['Cookie', 'Set-Cookie', 'Authorization']) {
      expect(redactText(`start\n${header}: sid=first; auth=second\nend`)).toBe(`start\n${header}: [已隐藏]\nend`);
    }
    expect(redactText('{"input_tokens":100,"output_tokens":5}')).toBe('{"input_tokens":100,"output_tokens":5}');
  });
  it("临时秘密按注册计数撤销，重复 dispose 不影响其他租约或长期秘密", async () => {
    const { registerTemporarySecrets, registerSecrets, redactText } = await import("../../src/shared/redact.js");
    const value = "temporary-fixture-778899";
    const a = registerTemporarySecrets([value, value]), b = registerTemporarySecrets([value]);
    expect(redactText(value)).toBe("[已隐藏]");
    a(); a(); expect(redactText(value)).toBe("[已隐藏]");
    b(); expect(redactText(value)).toBe(value);
    registerSecrets([value]); const c = registerTemporarySecrets([value]); c();
    expect(redactText(value)).toBe("[已隐藏]");
  });
  it("超过长期容量的临时令牌周转不挤占长期秘密", async () => {
    const { registerTemporarySecrets, registerSecrets, redactText } = await import("../../src/shared/redact.js");
    const warn = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    for (let i = 0; i < 3000; i++) {
      const value = "ephemeral-" + i + "-end";
      const dispose = registerTemporarySecrets([value]);
      expect(redactText(value)).toBe("[已隐藏]");
      dispose(); expect(redactText(value)).toBe(value);
    }
    registerSecrets(["permanent-after-churn"]);
    expect(redactText("permanent-after-churn")).toBe("[已隐藏]");
    await Promise.resolve(); expect(warn).not.toHaveBeenCalled();
  });
  it("长期秘密表饱和只告警一次，临时秘密仍可注册与撤销", async () => {
    const { registerTemporarySecrets, registerSecrets, redactText } = await import("../../src/shared/redact.js");
    const warn = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    registerSecrets(Array.from({ length: 2100 }, (_, i) => "long-" + i + "-end"));
    registerSecrets(["beyond-capacity"]);
    await Promise.resolve();
    expect(warn).toHaveBeenCalledOnce();
    const { logBuffer } = await import("../../src/shared/log.js");
    expect(logBuffer.recent()).toContainEqual(expect.objectContaining({ level: "warn", msg: "长期秘密表已满，新的长期秘密未注册" }));
    expect(JSON.parse(String(warn.mock.calls[0]![0]))).toMatchObject({ level: "warn", msg: "长期秘密表已满，新的长期秘密未注册" });
    expect(redactText("long-0-end")).toBe("[已隐藏]");
    expect(redactText("beyond-capacity")).toBe("beyond-capacity");
    const dispose = registerTemporarySecrets(["active-ephemeral"]);
    expect(redactText("active-ephemeral")).toBe("[已隐藏]");
    dispose(); expect(redactText("active-ephemeral")).toBe("active-ephemeral");
  });
  it("线程令牌在撤销、同一会话重新签发和关闭时移除临时秘密", async () => {
    const { ThreadTokens } = await import("../../src/context/media-recall-server.js");
    const { redactText } = await import("../../src/shared/redact.js");
    const tokens = new ThreadTokens({ recall: async () => ({ text: "ok", images: [] }) },
      { resolve: async () => { throw new Error("unused"); }, send: async () => ({}) });
    try {
      for (const mode of ["revoke", "reissue", "close"]) {
        const token = tokens.issue("owner");
        expect(redactText(token)).toBe("[已隐藏]");
        if (mode === "revoke") tokens.revoke("owner");
        if (mode === "reissue") tokens.issue("owner");
        if (mode === "close") tokens.close();
        expect(tokens.valid(token)).toBe(false);
        expect(redactText(token)).toBe(token);
      }
    } finally { tokens.close(); }
  });
});
