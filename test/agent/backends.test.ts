import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CODEX_LAST_FILE, CodexBackend, MAX_CODEX_TURNS, ticketWorkDir } from "../../src/agent/backends/codex.js";
import { tmp } from "./helpers.js";
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

  describe("CodexBackend per-ticket idempotency (R1)", () => {
    const req = { ticket: "abc123", scope: "private:1", access: "all", threadKey: "owner", source: { type: "private", user_id: "1", group_id: null, nickname: "n" }, text: "hi" } as const;
    const setup = () => {
      const dir = tmp("cs-codex-be-");
      const asks: { outputFile?: string }[] = [];
      const order: string[] = [];
      const runner = {
        ask: async (_p: string, o: { outputFile?: string }) => {
          order.push("ask");
          asks.push(o);
          return "fresh answer";
        },
      };
      const backend = new CodexBackend({ runner: runner as never, imagesDir: path.join(dir, "images"), ticketsDir: path.join(dir, "tickets") });
      return { dir, asks, order, backend, outFile: path.join(dir, "tickets", "abc123", CODEX_LAST_FILE) };
    };

    it("persists the turn marker (stable per-ticket -o path) before asking, and leaves the output file behind", async () => {
      const s = setup();
      const persisted: unknown[] = [];
      const res = await s.backend.handle(req, {
        signal: new AbortController().signal,
        onEvent: () => undefined,
        persistTurn: async (t) => {
          s.order.push("persist");
          persisted.push(t);
        },
      });
      expect(s.order).toEqual(["persist", "ask"]);
      expect(persisted).toEqual([{ outFile: s.outFile, attempts: 1 }]);
      expect(s.asks[0]!.outputFile).toBe(s.outFile);
      expect(res.text).toBe("fresh answer");
      expect(readFileSync(s.outFile, "utf8")).toBe("fresh answer"); // 补写，作为"已完成"标志
    });

    it("existing non-empty output → returned without asking", async () => {
      const s = setup();
      mkdirSync(path.dirname(s.outFile), { recursive: true });
      writeFileSync(s.outFile, "earlier answer\n");
      const res = await s.backend.handle(req, { signal: new AbortController().signal, onEvent: () => undefined, turn: { outFile: s.outFile, attempts: 1 } });
      expect(res.text).toBe("earlier answer");
      expect(s.asks).toHaveLength(0);
    });

    it("marker without output: re-asked once (attempt 2), refused after the second interruption", async () => {
      const s = setup();
      const persisted: { attempts: number }[] = [];
      const ctx = { signal: new AbortController().signal, onEvent: () => undefined, persistTurn: async (t: { attempts: number }) => void persisted.push(t) };
      await s.backend.handle(req, { ...ctx, turn: { outFile: s.outFile, attempts: 1 } });
      expect(persisted.map((p) => p.attempts)).toEqual([2]);
      expect(s.asks).toHaveLength(1);
      rmSync(s.outFile);
      await expect(s.backend.handle(req, { ...ctx, turn: { outFile: s.outFile, attempts: MAX_CODEX_TURNS } })).rejects.toThrow(/interrupted/);
      expect(s.asks).toHaveLength(1);
    });

    it("ticketWorkDir sanitizes and stays a direct child of the tickets root", () => {
      const root = path.resolve("/data/tickets");
      expect(ticketWorkDir(root, "a/../b")).toBe(path.join(root, "a____b"));
      expect(() => ticketWorkDir(root, "")).toThrow();
    });
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
