import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => vi.resetModules());
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("临时秘密生命周期与长期容量", () => {
  it("临时秘密按注册计数撤销，重复 dispose 不影响其他租约或长期秘密", async () => {
    const { registerTemporarySecrets, registerSecrets, redactText } = await import("../../src/obs/redact.js");
    const value = "temporary-fixture-778899";
    const a = registerTemporarySecrets([value, value]), b = registerTemporarySecrets([value]);
    expect(redactText(value)).toBe("[已隐藏]");
    a(); a(); expect(redactText(value)).toBe("[已隐藏]");
    b(); expect(redactText(value)).toBe(value);
    registerSecrets([value]); const c = registerTemporarySecrets([value]); c();
    expect(redactText(value)).toBe("[已隐藏]");
  });
  it("超过长期容量的临时令牌周转不挤占长期秘密", async () => {
    const { registerTemporarySecrets, registerSecrets, redactText } = await import("../../src/obs/redact.js");
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
    const { registerTemporarySecrets, registerSecrets, redactText } = await import("../../src/obs/redact.js");
    const warn = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    registerSecrets(Array.from({ length: 2100 }, (_, i) => "long-" + i + "-end"));
    registerSecrets(["beyond-capacity"]);
    await Promise.resolve();
    expect(warn).toHaveBeenCalledOnce();
    expect(JSON.parse(String(warn.mock.calls[0]![0]))).toMatchObject({ level: "warn", msg: "长期秘密表已满，新的长期秘密未注册" });
    expect(redactText("long-0-end")).toBe("[已隐藏]");
    expect(redactText("beyond-capacity")).toBe("beyond-capacity");
    const dispose = registerTemporarySecrets(["active-ephemeral"]);
    expect(redactText("active-ephemeral")).toBe("[已隐藏]");
    dispose(); expect(redactText("active-ephemeral")).toBe("active-ephemeral");
  });
  it("召回令牌在手动撤销、到期、外部取消和关闭时移除临时秘密", async () => {
    vi.useFakeTimers();
    const { RecallTokens } = await import("../../src/context/media-recall-server.js");
    const { redactText } = await import("../../src/obs/redact.js");
    const tokens = new RecallTokens({ recall: async () => ({ text: "ok", images: [] }) });
    try {
      for (const mode of ["revoke", "expire", "abort", "close"]) {
        const control = new AbortController();
        const lease = tokens.issue({ access: { kind: "all" }, ticket: mode, deadline: Date.now() + 1000, signal: control.signal });
        expect(redactText(lease.token)).toBe("[已隐藏]");
        if (mode === "revoke") lease.revoke();
        if (mode === "expire") await vi.advanceTimersByTimeAsync(1000);
        if (mode === "abort") control.abort();
        if (mode === "close") tokens.close();
        expect(tokens.valid(lease.token)).toBe(false);
        expect(redactText(lease.token)).toBe(lease.token);
      }
    } finally { tokens.close(); }
  });
});
