import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { SandboxDO } from "../src/sandbox/do";
import { sandboxClient, workPath, type ExecResult } from "../src/sandbox/client";
import { scriptedModel } from "./events-helpers";
import { input } from "./helpers";

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

const CODING_TOOLS = ["read", "write", "edit", "bash"];
const auditRows = (kind: string) => runInDurableObject(env.THREAD.getByName("owner"), (_instance, state) =>
  state.storage.sql.exec<{ detail: string }>("SELECT detail FROM events WHERE kind = ?", kind).toArray().map(row => JSON.parse(row.detail) as Record<string, unknown>));
const admin = (method: string, path: string) =>
  worker.fetch(new Request(`https://test${path}`, { method, headers: { Authorization: "Bearer test-admin-only" } }), { ...env, ADMIN_TOKEN: "test-admin-only" });

describe("workPath", () => {
  it("resolves model paths under /work and rejects anything that leaves it", () => {
    expect(workPath("a/b.txt")).toBe("/work/a/b.txt");
    expect(workPath("./out/../x.py")).toBe("/work/x.py");
    expect(workPath("/work")).toBe("/work");
    expect(workPath("/work//out/")).toBe("/work/out");
    for (const raw of ["../etc/passwd", "/etc/passwd", "/work/../etc", "/workspace/x", "a/../../..", "/"]) expect(() => workPath(raw), raw).toThrow("path_denied");
    expect(() => workPath("a\0b")).toThrow("invalid_request");
  });
});

describe("sandboxClient", () => {
  it("speaks the control service protocol and turns error bodies into failure codes", async () => {
    const send = vi.fn(async (_path: string, _init?: RequestInit) => Response.json({ stdout: "", stderr: "", code: 0, timedOut: false, truncated: false }));
    const client = sandboxClient(send);
    await client.exec("ls", { timeoutMs: 999_999 });
    expect(send.mock.calls[0]![0]).toBe("/exec");
    expect(JSON.parse(String(send.mock.calls[0]![1]!.body))).toEqual({ cmd: "ls", cwd: "/work", timeoutMs: 120_000 });
    await client.readFile("notes.md", { offset: 3 });
    expect(send.mock.calls[1]![0]).toBe("/file?path=%2Fwork%2Fnotes.md&offset=3");
    await client.writeFile("out/a.txt", "内容");
    expect([send.mock.calls[2]![0], send.mock.calls[2]![1]!.method, send.mock.calls[2]![1]!.body]).toEqual(["/file?path=%2Fwork%2Fout%2Fa.txt", "PUT", "内容"]);

    send.mockResolvedValueOnce(Response.json({ error: "edit_ambiguous" }, { status: 400 }));
    await expect(client.editFile("a.txt", [{ oldText: "x", newText: "y" }])).rejects.toThrow("edit_ambiguous");
    send.mockResolvedValueOnce(Response.json({ error: "something new" }, { status: 400 }));
    await expect(client.list("/work")).rejects.toThrow("sandbox_error");
    send.mockResolvedValueOnce(new Response("<html>bad gateway</html>", { status: 502 }));
    await expect(client.list("/work")).rejects.toThrow("sandbox_error");
    await expect(client.readFile("../../etc/shadow")).rejects.toThrow("path_denied");
    expect(send).toHaveBeenCalledTimes(6);
  });
});

/** 测试池不起容器；把 ctx.container 换成假的，控制端口的 fetch 由测试决定。 */
function fakeContainer(port: (url: string, init?: RequestInit) => Promise<Response>) {
  const state = { running: false, starts: [] as unknown[], idle: [] as unknown[], destroyed: 0 };
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const pathname = new URL(url).pathname;
    if (pathname === "/restore/start") return Response.json({ id: "restore" });
    if (pathname === "/restore/commit") return Response.json({ restored: true });
    if (pathname === "/snapshot") return Response.json({ files: [], directories: [], totalBytes: 0 });
    return port(url, init);
  });
  const container = {
    get running() { return state.running; },
    images: { sandbox: "registry.test/sandbox:1" },
    start(options: unknown) { state.running = true; state.starts.push(options); },
    monitor: () => new Promise<void>(() => {}),
    setInactivityTimeout: async (ms: number) => { state.idle.push(ms); },
    getTcpPort: () => ({ fetch }),
    destroy: async () => { state.running = false; state.destroyed++; },
  };
  return { state, fetch, container };
}
function withContainer<T>(container: object, work: (sandbox: SandboxDO) => Promise<T>): Promise<T> {
  return runInDurableObject(env.SANDBOX.getByName("owner"), async (instance, ctx) => {
    if (!(instance instanceof SandboxDO)) throw new Error("expected SandboxDO");
    const proxied = new Proxy(ctx, { get: (target, key) => {
      if (key === "container") return container;
      const value: unknown = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    Object.defineProperty(instance, "ctx", { value: proxied });
    return work(instance);
  });
}

describe("SandboxDO", () => {
  it("starts the container on demand, waits for the control port, then sends each call once", async () => {
    vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
    let healthChecks = 0;
    const result: ExecResult = { stdout: "ok\n", stderr: "", code: 0, timedOut: false, truncated: false };
    const { state, fetch, container } = fakeContainer(async url => {
      if (url.endsWith("/health")) {
        if (++healthChecks < 3) throw new Error("connection refused");
        return Response.json({ ok: true });
      }
      return Response.json(result);
    });
    await withContainer(container, async sandbox => {
      expect(await sandbox.status()).toBe("stopped");
      expect(await sandbox.exec("echo ok", { timeoutMs: 5000 })).toEqual(result);
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 6 * 60_000);
      expect(await sandbox.exec("echo ok", { timeoutMs: 5000 })).toEqual(result);
      expect(await sandbox.status()).toBe("running");
    });
    expect(state.starts).toEqual([{ image: "registry.test/sandbox:1", enableInternet: true, instance: "lite" }]);
    expect(state.idle.every(value => value === 180_000)).toBe(true);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(["http://sandbox/health", "http://sandbox/health", "http://sandbox/health", "http://sandbox/restore/start", "http://sandbox/restore/commit", "http://sandbox/exec", "http://sandbox/snapshot", "http://sandbox/exec", "http://sandbox/snapshot"]);
  });

  it("does not replay a call that failed after the port was ready, and re-checks readiness next time", async () => {
    let failExec = true;
    const { fetch, container } = fakeContainer(async url => {
      if (url.endsWith("/exec") && failExec) { failExec = false; throw new Error("connection reset"); }
      return Response.json(url.endsWith("/health") ? { ok: true } : { stdout: "", stderr: "", code: 0, timedOut: false, truncated: false });
    });
    await withContainer(container, async sandbox => {
      await expect(sandbox.exec("make", { timeoutMs: 5000 })).rejects.toThrow("operation_unknown");
      await sandbox.exec("make", { timeoutMs: 5000 });
    });
    expect(fetch.mock.calls.filter(([url]) => url.endsWith("/exec"))).toHaveLength(2);
    expect(fetch.mock.calls.filter(([url]) => url.endsWith("/health"))).toHaveLength(2);
  });

  it("gives up with sandbox_unavailable when the control port never comes up", async () => {
    vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
    const { fetch, container } = fakeContainer(async () => { throw new Error("connection refused"); });
    await withContainer(container, sandbox => expect(sandbox.readFile("a.txt")).rejects.toThrow("sandbox_unavailable"));
    expect(fetch).toHaveBeenCalledTimes(SandboxDO.START_ATTEMPTS);
  });

  it("reset destroys a running container", async () => {
    const { state, container } = fakeContainer(async url => Response.json(url.endsWith("/health") ? { ok: true } : { bytes: 1 }));
    await withContainer(container, async sandbox => {
      expect(await sandbox.reset()).toEqual({ reset: false });
      await sandbox.writeFile("a.txt", "x");
      expect(await sandbox.reset()).toEqual({ reset: true });
    });
    expect(state.destroyed).toBe(1);
  });

  it("reports sandbox_unavailable without a container binding", async () => {
    const sandbox = env.SANDBOX.getByName("owner");
    // RPC 的 promise 被 expect().rejects 探查属性时会派生新的调用，先转成普通 promise 再断言。
    const failure = (call: Promise<unknown>) => call.then(() => "resolved", (error: Error) => error.message);
    expect(await sandbox.status()).toBe("unavailable");
    expect(await failure(sandbox.exec("ls", { timeoutMs: 1000 }))).toBe("sandbox_unavailable");
    expect(await failure(sandbox.reset())).toBe("sandbox_unavailable");
  });
});

describe("coding tools", () => {
  it("are offered in owner message turns and not in group threads", async () => {
    const seen = scriptedModel([{ name: "", args: {} }, { name: "", args: {} }]);
    expect(await env.THREAD.getByName("owner").submit(input(1, "写个脚本", 10000001))).toEqual({ status: "done" });
    expect(seen.requests[0]!.tools).toEqual(expect.arrayContaining(CODING_TOOLS));
    expect(await env.THREAD.getByName("group:200000001").submit(input(2, "跑个脚本", 10000003, 200000001, true))).toEqual({ status: "done" });
    for (const name of CODING_TOOLS) expect(seen.requests[1]!.tools).not.toContain(name);
  });

  it("tells the model the sandbox is unavailable and audits only the classification", async () => {
    const seen = scriptedModel([{ name: "bash", args: { command: "cat 秘密文件.txt" } }, { name: "write", args: { path: "out/a.txt", content: "机密内容" } }, { name: "", args: {} }]);
    expect(await env.THREAD.getByName("owner").submit(input(1, "跑一下", 10000001))).toEqual({ status: "done" });
    expect(seen.outputs[0]).toContain("sandbox_unavailable");
    expect(seen.outputs[1]).toContain("sandbox_unavailable");
    const exec = await auditRows("coding_exec"), write = await auditRows("coding_write");
    expect(exec).toEqual([{ result: "sandbox_unavailable", commandLength: "cat 秘密文件.txt".length, ms: expect.any(Number) }]);
    expect(write).toEqual([{ result: "sandbox_unavailable", ms: expect.any(Number) }]);
    expect(JSON.stringify([exec, write])).not.toMatch(/秘密|机密|out\/a/);
  });

  it("shows stdout, stderr and a non-zero exit code to the model", async () => {
    const exec = vi.spyOn(SandboxDO.prototype, "exec").mockResolvedValue({ stdout: "built\n", stderr: "warning: x\n", code: 2, timedOut: false, truncated: false });
    const seen = scriptedModel([{ name: "bash", args: { command: "make", timeout: 90 } }, { name: "", args: {} }]);
    expect(await env.THREAD.getByName("owner").submit(input(1, "编译", 10000001))).toEqual({ status: "done" });
    expect(exec).toHaveBeenCalledWith("make", { cwd: "/work", timeoutMs: 90_000, operationId: expect.stringMatching(/^task:/) });
    expect(seen.outputs[0]).toBe("built\n\n[stderr]\nwarning: x\n\nCommand exited with code 2");
    expect(await auditRows("coding_exec")).toEqual([{ result: "ok", commandLength: 4, code: 2, ms: expect.any(Number) }]);
  });

  it("points read at the next offset and repairs edits sent as a JSON string", async () => {
    vi.spyOn(SandboxDO.prototype, "readFile").mockResolvedValue({ text: "a\nb", startLine: 1, endLine: 2, totalLines: 5 });
    const edit = vi.spyOn(SandboxDO.prototype, "editFile").mockResolvedValue({ replaced: 1 });
    const seen = scriptedModel([
      { name: "read", args: { path: "main.py", limit: 2 } },
      { name: "edit", args: { path: "main.py", edits: JSON.stringify([{ oldText: "a", newText: "A" }]) } },
      { name: "", args: {} },
    ]);
    expect(await env.THREAD.getByName("owner").submit(input(1, "改一下", 10000001))).toEqual({ status: "done" });
    expect(seen.outputs[0]).toBe("a\nb\n\n[Showing lines 1-2 of 5. Use offset=3 to continue.]");
    expect(edit).toHaveBeenCalledWith("main.py", [{ oldText: "a", newText: "A" }], expect.stringMatching(/^task:/));
    expect(seen.outputs[1]).toBe("Successfully replaced 1 block(s) in main.py.");
  });
});

describe("admin sandbox", () => {
  it("shows the owner sandbox state and maps a reset without containers to 503", async () => {
    const overview = await (await admin("GET", "/admin/overview")).json<{ threads: { key: string; sandbox?: string }[] }>();
    expect(overview.threads.find(thread => thread.key === "owner")?.sandbox).toBe("unavailable");
    const response = await admin("POST", "/admin/threads/owner/sandbox/reset");
    expect([response.status, await response.json()]).toEqual([503, { error: "sandbox_unavailable" }]);
    expect((await admin("POST", "/admin/threads/nobody/sandbox/reset")).status).toBe(404);
  });
});
