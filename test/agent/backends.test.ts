import { describe, expect, it } from "vitest";
import { backendNameFor, createBackendSelector, parseBackendOverrides, PI_NOT_IMPLEMENTED, PiBackendStub } from "../../src/agent/backends/select.js";
import type { AgentBackend } from "../../src/agent/backends/types.js";

const codex: AgentBackend = { name: "codex", handle: async () => ({ text: "c" }) };

describe("backend selection (§4.3)", () => {
  it("parses AGENT_BACKEND_OVERRIDES", () => {
    expect(parseBackendOverrides("group:200000001=pi, private:10000001=codex")).toEqual({
      "group:200000001": "pi",
      "private:10000001": "codex",
    });
    expect(parseBackendOverrides("")).toEqual({});
    expect(parseBackendOverrides(undefined)).toEqual({});
  });

  it("rejects malformed override entries", () => {
    expect(() => parseBackendOverrides("group:1=claude")).toThrow(/后端非法/);
    expect(() => parseBackendOverrides("room:1=pi")).toThrow(/scope 非法/);
    expect(() => parseBackendOverrides("group:1")).toThrow(/scope 非法/);
  });

  it("override wins over the global default", () => {
    const o = parseBackendOverrides("group:7=pi");
    expect(backendNameFor("group:7", "codex", o)).toBe("pi");
    expect(backendNameFor("group:8", "codex", o)).toBe("codex");
    expect(backendNameFor("private:1", "pi", {})).toBe("pi");
  });

  it("selector returns the registered backend; the pi stub throws the group-3 message", async () => {
    const sel = createBackendSelector({ defaultBackend: "codex", overrides: { "group:7": "pi" }, backends: { codex, pi: new PiBackendStub() } });
    expect(sel.select("group:8")).toBe(codex);
    const pi = sel.select("group:7");
    expect(pi.name).toBe("pi");
    await expect(pi.handle({} as never, {} as never)).rejects.toThrow(PI_NOT_IMPLEMENTED);
    expect(PI_NOT_IMPLEMENTED).toBe("pi backend not implemented yet (group 3)");
    const missing = createBackendSelector({ defaultBackend: "pi", overrides: {}, backends: { codex } });
    expect(() => missing.select("group:1")).toThrow(/not registered/);
  });
});
