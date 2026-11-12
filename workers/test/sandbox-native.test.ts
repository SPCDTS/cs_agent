import { env, reset, runInDurableObject } from "cloudflare:test";
import { Files } from "@cloudflare/sandbox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nativeSandboxClient, type NativeContainer, type NativeFiles } from "../src/sandbox/native";
import { SandboxDO } from "../src/sandbox/do";
import { sha256 } from "../src/media/model";

const encoder = new TextEncoder();
afterEach(async () => { vi.restoreAllMocks(); await reset(); });
function fixture() {
  const contents = new Map<string, Uint8Array>(), directories = new Set(["/work"]);
  const calls: { command: string[]; input: unknown; options: ContainerExecOptions | undefined }[] = [];
  let helperResult: unknown = undefined, disconnected = false;
  const container: NativeContainer = {
    async exec(command, options) {
      if (disconnected) throw new Error("transport lost");
      if (!(options?.stdin instanceof ReadableStream)) throw new Error("expected native stdin");
      const input: unknown = await new Response(options.stdin).json();
      calls.push({ command, input, options });
      let result: unknown = helperResult;
      if (result === undefined && input && typeof input === "object" && "path" in input && typeof input.path === "string") {
        result = input.path.startsWith("/work/escape") ? { error: "path_denied" } : input.path;
      }
      if (result === undefined && command.at(-1) === "restore") result = { restored: true };
      if (result === undefined && command.at(-1) === "snapshot") result = { files: [], directories: [], totalBytes: 0 };
      if (result === undefined && command.at(-1) === "exec") result = { stdout: "ok\n", stderr: "", code: 0, timedOut: false, truncated: false };
      return { stdin: null, stdout: null, stderr: null, pid: 1, isPty: false, exitCode: Promise.resolve(0), kill() {}, resize() {},
        async output() { return { stdout: await new Blob([JSON.stringify(result)]).arrayBuffer(), stderr: new ArrayBuffer(0), exitCode: 0 }; } };
    },
  };
  const missing = (path: string) => Object.assign(new Error("missing"), { name: "SandboxFileError", code: "ENOENT", operation: "stat", path, detail: "missing" });
  const nativeFiles: NativeFiles = {
    readFile: vi.fn<NativeFiles["readFile"]>(async path => { const bytes = contents.get(path); if (!bytes) throw missing(path); return new Response(bytes); }),
    writeFile: vi.fn<NativeFiles["writeFile"]>(async (path, value) => {
      const bytes = typeof value === "string" ? encoder.encode(value) : value instanceof ArrayBuffer ? new Uint8Array(value) : ArrayBuffer.isView(value) ? new Uint8Array(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)) : new Uint8Array(await new Response(value).arrayBuffer());
      contents.set(path, bytes);
    }),
    stat: vi.fn<NativeFiles["stat"]>(async path => {
      const bytes = contents.get(path), isDir = directories.has(path);
      if (!bytes && !isDir) throw missing(path);
      return { type: isDir ? "directory" : "file", size: BigInt(bytes?.byteLength ?? 0), mode: 420, uid: 1000, gid: 1000, accessedAt: new Date(), modifiedAt: new Date(), changedAt: new Date() };
    }),
    mkdir: vi.fn<NativeFiles["mkdir"]>(async path => { directories.add(path); }),
    remove: vi.fn<NativeFiles["remove"]>(async () => {}),
    readDirectory: vi.fn<NativeFiles["readDirectory"]>(async () => [{ name: "report.md", type: "file" }, { name: "link", type: "symlink" }]),
  };
  const client = nativeSandboxClient({ container: async () => container, files: () => nativeFiles });
  return { client, container, contents, directories, calls, nativeFiles, result(value: unknown) { helperResult = value; }, disconnect() { disconnected = true; } };
}

describe("官方 Files 与原生 Container 适配器", () => {
  it("二进制写入保留子视图边界，目录操作仍受 /work 与 realpath 限制", async () => {
    const f = fixture(), bytes = new Uint8Array([10, 0, 255, 128, 20]).subarray(1, 4);
    expect(await f.client.writeFile(".codemode/out/image.png", bytes)).toEqual({ bytes: 3 });
    expect(await f.client.readBlob(".codemode/out/image.png")).toEqual(new Uint8Array([0, 255, 128]));
    await f.client.mkdir(".codemode/empty");
    expect(f.nativeFiles.mkdir).toHaveBeenCalledWith("/work/.codemode/empty", { recursive: true, user: "1000:1000" });
    await f.client.remove(".codemode/empty");
    expect(f.nativeFiles.remove).toHaveBeenCalledWith("/work/.codemode/empty", { recursive: true, force: true, user: "1000:1000" });
    await expect(f.client.remove("/work")).rejects.toThrow("path_denied");
    await expect(f.client.mkdir("escape/out")).rejects.toThrow("path_denied");
  });
  it("原生 stdin 传递参数，文件读写使用 uid/gid 1000，返回 UTF-8 字节数", async () => {
    const f = fixture();
    expect(await f.client.writeFile("out/report.md", "中文\r\n第二行")).toEqual({ bytes: 17 });
    expect(f.nativeFiles.mkdir).toHaveBeenCalledWith("/work/out", { recursive: true, user: "1000:1000" });
    expect(f.nativeFiles.writeFile).toHaveBeenCalledWith("/work/out/report.md", "中文\r\n第二行", { user: "1000:1000" });
    expect(await f.client.readFile("out/report.md", { offset: 2, limit: 1 })).toEqual({ text: "第二行", startLine: 2, endLine: 2, totalLines: 2 });
    expect(f.calls[0]).toMatchObject({ command: ["/usr/local/bin/node", "/opt/sandbox/runtime.mjs", "resolve"], input: { path: "/work/out/report.md" } });
    await expect(f.client.readFile("out/report.md", { offset: 3 })).rejects.toThrow("offset_out_of_range");
    await expect(f.client.readFile("missing.txt")).rejects.toThrow("not_found");
  });
  it("edit 保留中文、UTF-8 BOM 与 CRLF，拒绝歧义或重叠且不改原文", async () => {
    const f = fixture(), original = "\uFEFF中文 alpha beta gamma beta\r\n第二行\r\n";
    f.contents.set("/work/a.md", encoder.encode(original));
    expect(await f.client.editFile("a.md", [{ oldText: "alpha", newText: "甲" }, { oldText: "gamma", newText: "丙" }])).toEqual({ replaced: 2 });
    const changed = new TextDecoder("utf-8", { ignoreBOM: true, fatal: false }).decode(f.contents.get("/work/a.md"));
    expect(changed).toBe("\uFEFF中文 甲 beta 丙 beta\r\n第二行\r\n");
    await expect(f.client.editFile("a.md", [{ oldText: "beta", newText: "乙" }])).rejects.toThrow("edit_ambiguous");
    await expect(f.client.editFile("a.md", [{ oldText: "甲 beta", newText: "一" }, { oldText: "beta 丙", newText: "二" }])).rejects.toThrow("edit_overlap");
    await expect(f.client.editFile("a.md", [{ oldText: "missing", newText: "" }])).rejects.toThrow("edit_not_found");
    expect(new TextDecoder("utf-8", { ignoreBOM: true, fatal: false }).decode(f.contents.get("/work/a.md"))).toBe(changed);
  });
  it("图片按真实字节返回，普通二进制拒绝文本读取，目录保留链接类型", async () => {
    const f = fixture(), png = new Uint8Array([137,80,78,71,13,10,26,10,0,255]);
    f.contents.set("/work/image.png", png); f.contents.set("/work/binary.bin", new Uint8Array([0,1])); f.contents.set("/work/report.md", encoder.encode("中文"));
    expect(await f.client.readFile("image.png")).toEqual({ kind: "image", data: "iVBORw0KGgoA/w==", mimeType: "image/png" });
    await expect(f.client.readFile("binary.bin")).rejects.toThrow("binary_file");
    expect(await f.client.readBlob("image.png")).toEqual(png);
    expect(await f.client.list("/work")).toEqual([{ name: "report.md", type: "file", size: 6 }, { name: "link", type: "link", size: 0 }]);
  });
  it("词法路径与 realpath 两道边界拒绝逃逸，原生失联或非法回包不冒充结果", async () => {
    const f = fixture();
    await expect(f.client.readBlob("../outside")).rejects.toThrow("path_denied");
    await expect(f.client.writeFile("escape/new.txt", "x")).rejects.toThrow("path_denied");
    expect(f.nativeFiles.writeFile).not.toHaveBeenCalled();
    f.result({ stdout: "incomplete" });
    await expect(f.client.exec("echo hello", { timeoutMs: 100 })).rejects.toThrow("sandbox_unavailable");
    f.disconnect(); await expect(f.client.readBlob("a.txt")).rejects.toThrow("sandbox_unavailable");
  });
  it("命令只作为固定容器助手的数据输入，进程结果包含真实退出码", async () => {
    const f = fixture(), command = "printf '中文'; exit 7";
    f.result({ stdout: "中文", stderr: "", code: 7, timedOut: false, truncated: false });
    expect(await f.client.exec(command, { cwd: "out", timeoutMs: 200000 })).toMatchObject({ stdout: "中文", code: 7 });
    expect(f.calls[0]).toMatchObject({ command: ["/usr/local/bin/node", "/opt/sandbox/runtime.mjs", "exec"], input: { command, cwd: "/work/out", timeoutMs: 120000 }, options: { user: "0:0", cwd: "/work" } });
    expect(f.calls[0].options?.signal).toBeInstanceOf(AbortSignal);
  });
  it("恢复走 Files 二进制 staging，助手校验后提交，最后删除临时目录", async () => {
    const f = fixture(), bytes = new Uint8Array([0,255,7]);
    f.result({ restored: true });
    const snapshot = { files: [{ path: "old/node_modules/data.bin", bytes: 3, sha256: await sha256(bytes), mime: "application/octet-stream", mode: 420 }], directories: ["empty"], totalBytes: 3 };
    await f.client.restore(snapshot, async () => bytes);
    const stage = f.calls[0].input;
    expect(stage).toMatchObject({ snapshot });
    expect(f.nativeFiles.writeFile).toHaveBeenCalledWith(expect.stringMatching(/^\/tmp\/sandbox-import-[a-f0-9-]+\/old\/node_modules\/data.bin$/), bytes, { user: "1000:1000" });
    expect(f.nativeFiles.remove).toHaveBeenCalledWith(expect.stringMatching(/^\/tmp\/sandbox-import-[a-f0-9-]+$/), { recursive: true, force: true, user: "1000:1000" });
    f.result({ files: [], directories: [], totalBytes: 0 });
    await f.client.snapshot(["old/node_modules/data.bin"]);
    expect(f.calls.at(-1)?.input).toEqual({ retainedPaths: ["old/node_modules/data.bin"] });
  });
  it("SandboxDO 按需启动原生容器，复用回执，执行失联立即销毁且不重放", async () => {
    const f = fixture(), state = { running: false, starts: 0, destroyed: 0, idle: [] as number[] };
    vi.spyOn(Files.prototype, "mkdir").mockImplementation(f.nativeFiles.mkdir);
    vi.spyOn(Files.prototype, "remove").mockImplementation(f.nativeFiles.remove);
    const container = {
      ...f.container, get running() { return state.running; }, images: { sandbox: "registry.test/native:1" },
      start: vi.fn((options: unknown) => { expect(options).toEqual({ image: "registry.test/native:1", enableInternet: true, instance: "lite" }); state.running = true; state.starts++; }),
      monitor: () => new Promise<void>(() => {}),
      setInactivityTimeout: async (ms: number) => { state.idle.push(ms); },
      destroy: async () => { state.running = false; state.destroyed++; },
      getTcpPort: () => { throw new Error("HTTP control port must not be used"); },
    };
    await runInDurableObject(env.SANDBOX.getByName("native-lifecycle"), async (instance, ctx) => {
      if (!(instance instanceof SandboxDO)) throw new Error("expected SandboxDO");
      const proxied = new Proxy(ctx, { get: (target, key) => {
        if (key === "container") return container;
        const value: unknown = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      } });
      Object.defineProperty(instance, "ctx", { value: proxied });
      expect(await instance.status()).toBe("stopped");
      const options = { timeoutMs: 1000, operationId: "stable" };
      expect(await instance.exec("echo ok", options)).toMatchObject({ stdout: "ok\n", code: 0 });
      expect(await instance.exec("echo ok", options)).toMatchObject({ stdout: "ok\n", code: 0 });
      expect(f.calls.filter(call => call.command.at(-1) === "exec")).toHaveLength(1);
      f.disconnect();
      const input = { operationId: "uncertain", operation: { kind: "exec", command: "side effect" } } satisfies Parameters<SandboxDO["run"]>[0];
      expect(await instance.run(input)).toMatchObject({ status: "unknown" });
      expect(state.destroyed).toBe(1); expect(await instance.status()).toBe("stopped");
      expect(await instance.run(input)).toMatchObject({ status: "unknown" });
      expect(state.starts).toBe(1); expect(state.idle.every(ms => ms === SandboxDO.IDLE_MS)).toBe(true);
    });
  });
});
