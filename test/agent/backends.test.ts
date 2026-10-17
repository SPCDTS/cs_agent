import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CODEX_LAST_FILE, CodexBackend, MAX_CODEX_TURNS, ticketWorkDir } from "../../src/agent/backends/codex.js";
import { FIXTURES, tmp } from "./helpers.js";
import { describe, expect, it, vi } from "vitest";
import { CodexRunner, type AskOptions } from "../../src/agent/codex-runner.js";
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
        ask: async (_p: string, o: AskOptions) => {
          await o.onAcquired?.();
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

    it("two restarts while queued keep attempts at zero, then the ticket runs once (F5)", async () => {
      const dir = tmp("cs-codex-queued-");
      const logFile = path.join(dir, "calls.jsonl");
      let turn: { outFile: string; attempts: number } | undefined;
      const persistTurn = vi.fn(async (state: { outFile: string; attempts: number }) => { turn = state; });
      const makeRunner = (sleep: string) => new CodexRunner({
        command: [process.execPath, path.join(FIXTURES, "fake-codex.mjs")],
        codexHome: path.join(dir, "codex"), workspaceDir: path.join(dir, "ws"),
        threadsFile: path.join(dir, "threads.json"), sandbox: "workspace-write", timeoutMs: 120_000,
        env: { FAKE_CODEX_LOG: logFile, FAKE_CODEX_SLEEP_MS: sleep },
      });
      for (let restart = 0; restart < 2; restart++) {
        const runner = makeRunner("60000");
        const head = new AbortController();
        const waiting = new AbortController();
        const long = runner.ask("long turn", { threadKey: "owner", signal: head.signal }).catch(() => undefined);
        await vi.waitFor(() => {
          expect(existsSync(logFile)).toBe(true);
          expect(readFileSync(logFile, "utf8").trim().split("\n")).toHaveLength(restart + 1);
        });
        const ask = vi.spyOn(runner, "ask");
        const backend = new CodexBackend({ runner, imagesDir: path.join(dir, "images"), ticketsDir: path.join(dir, "tickets") });
        const queued = backend.handle(req, { signal: waiting.signal, onEvent: () => undefined, turn, persistTurn }).catch(() => undefined);
        await vi.waitFor(() => expect(ask).toHaveBeenCalledOnce());
        expect(turn?.attempts ?? 0).toBe(0);
        waiting.abort();
        head.abort();
        await Promise.all([long, queued]);
        expect(persistTurn).not.toHaveBeenCalled();
      }
      const backend = new CodexBackend({ runner: makeRunner("0"), imagesDir: path.join(dir, "images"), ticketsDir: path.join(dir, "tickets") });
      await backend.handle(req, { signal: new AbortController().signal, onEvent: () => undefined, turn, persistTurn });
      expect(turn?.attempts).toBe(1);
      expect(persistTurn).toHaveBeenCalledOnce();
      const starts = readFileSync(logFile, "utf8").trim().split("\n").map(l => JSON.parse(l)).filter(c => c.phase === "start");
      expect(starts.filter(c => c.stdin.endsWith("\nhi"))).toHaveLength(1);
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
