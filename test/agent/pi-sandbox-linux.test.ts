import { DatabaseSync } from "node:sqlite";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import { BACKGROUND_CONTEXT as context, withAbortSignal } from "@earendil-works/chord/context";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sandboxFixture, put } from "./pi-sandbox-fixture.js";
import { codingEnvironment } from "../../src/agent/pi-tools/coding.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); vi.unstubAllEnvs(); });

// Linux 上不因缺 bwrap/不允许 user namespace 而跳过：容器的 seccomp 回归必须使测试失败。
describe.runIf(process.platform === "linux")("真实 bwrap（请以容器 node 用户运行）", () => {
  it("owner 与非 owner 发送者的 bash 都不能写技能目录", async () => {
    const { dir, options } = await fixture(), skillsDir = path.join(dir, "skills");
    const file = await put(path.join(skillsDir, "hello", "SKILL.md"), "初始内容");
    for (const senderIsOwner of [true, false]) {
      const env = await codingEnvironment({ ...options, request: { ...options.request, senderIsOwner } });
      cleanup.push(() => env.cleanup(context));
      const script = `const fs = require('node:fs'); try { fs.writeFileSync(${JSON.stringify(file)}, 'owner'); } catch { process.exit(3); }`;
      expect(await env.exec([process.execPath, "-e", script], undefined, context)).toMatchObject({ ok: true, value: { exitCode: 3 } });
    }
    expect(await fs.readFile(file, "utf8")).toBe("初始内容");
  });
  async function fixture() {
    // 不放 /tmp：该目录整体被 tmpfs 覆盖，会掩盖 deny_read 挂载本身的错误。
    const dir = await fs.mkdtemp("/var/tmp/cs-pi-sandbox-");
    cleanup.push(() => fs.rm(dir, { recursive: true, force: true }));
    const s = await sandboxFixture("group:7", "ticket-7", dir);
    cleanup.push(() => s.env.cleanup(context));
    return s;
  }

  it("主人在只读挂载中查询持续写入的 WAL 库与日志，其他会话仍被遮蔽且任何回合都不能写", async () => {
    const { dir, options } = await fixture();
    const file = path.join(dir, "observability.sqlite"), log = await put(path.join(dir, "logs", "cs-agent.jsonl"), "log-evidence");
    const writer = new DatabaseSync(file);
    try {
      writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE evidence (n INTEGER); INSERT INTO evidence VALUES (1)");
      await fs.access(file + "-wal"); await fs.access(file + "-shm");
      const owner = await codingEnvironment({ ...options, key: "owner", request: { access: "all", inputs: [] } });
      cleanup.push(() => owner.cleanup(context));
      for (const n of [1, 2]) {
        if (n === 2) writer.exec("INSERT INTO evidence VALUES (2)");
        let output = "";
        const script = "const fs = require('node:fs'); const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(" + JSON.stringify(file) + ", { readOnly: true }); " +
          "const writable = p => { try { fs.appendFileSync(p, 'bad'); return true; } catch { return false; } }; " +
          "console.log(JSON.stringify({ count: db.prepare('SELECT count(*) AS n FROM evidence').get().n, log: fs.readFileSync(" + JSON.stringify(log) + ", 'utf8'), writable: " +
          JSON.stringify([file, file + "-wal", file + "-shm", log]) + ".map(writable) })); db.close();";
        expect(await owner.exec([process.execPath, "-e", script], { onOutput: text => { output += text; } }, context), output).toMatchObject({ ok: true, value: { exitCode: 0 } });
        expect(JSON.parse(output.trim())).toEqual({ count: n, log: "log-evidence", writable: [false, false, false, false] });
      }
      for (const key of ["group:7", "private:5"]) {
        const env = await codingEnvironment({ ...options, key, request: { access: key, inputs: [] } });
        cleanup.push(() => env.cleanup(context));
        let output = "";
        const script = "const fs = require('node:fs'); const read = p => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } }; console.log(JSON.stringify(" +
          JSON.stringify([file, file + "-wal", file + "-shm", log]) + ".map(read)));";
        expect(await env.exec([process.execPath, "-e", script], { onOutput: text => { output += text; } }, context), output).toMatchObject({ ok: true, value: { exitCode: 0 } });
        expect(JSON.parse(output.trim())).toEqual(["", "", "", ""]);
      }
    } finally { writer.close(); }
  });

  it("遮蔽库/令牌/其他会话；仅工作区和临时 /tmp 可写，proc 为新 PID 空间", async () => {
    expect(process.getuid!(), "必须以非 root 用户验证与生产一致的 user namespace 行为").not.toBe(0);
    const { dir, workspaceDir, env } = await fixture();
    const secret = "fixture-private-content";
    const files = await Promise.all(["qq-messages.sqlite", "qq-messages.sqlite-wal", "obs-token", "pi.sqlite", "pi.sqlite-shm", "codex/auth.json", "pi-work/group_8/note", "images/group_7/a", "media/a", "incoming/ticket-7/a"].map(p => put(path.join(dir, p), secret)));
    const crossScope = await Promise.all([
      put(path.join(workspaceDir, "group_8", "note"), secret), put(path.join(dir, "codex", "trace", "x.json"), secret),
    ]);
    files.push(...crossScope);
    for (const file of crossScope) {
      for (const result of await Promise.all([
        env.readTextFile(file, context), env.readTextLines(file, undefined, context), env.openTextLineReader(file, context),
        env.readBinaryFile(file, context), env.openBinaryReader(file, undefined, context), env.fileInfo(file, context),
      ])) expect(result).toMatchObject({ ok: false, error: { code: "permission_denied" } });
    }
    const archive = await put(path.join(dir, "codex-threads-archive.jsonl"), '{"thread_id":"ids-only"}');
    expect(await env.readTextFile(archive, context)).toMatchObject({ ok: true, value: '{"thread_id":"ids-only"}' });
    const original = await put(path.join(dir, "public-file"), "public-content");
    await fs.symlink(files[0]!, path.join(env.cwd, "alias"));
    const hostPidNamespace = await fs.readlink("/proc/self/ns/pid");
    vi.stubEnv("PI_PRIVATE_SECRET", secret);
    vi.stubEnv("COMFYUI_URL", "https://alice:password@example.com");
    let output = "";
    const script = `
      const fs = require('node:fs');
      const paths = ${JSON.stringify([...files, path.join(env.cwd, "alias")])};
      const read = p => { try { return fs.readFileSync(p, 'utf8'); } catch { return 'DENIED'; } };
      const write = p => { try { fs.writeFileSync(p, 'changed'); return true; } catch { return false; } };
      console.log(JSON.stringify({
        contents: paths.map(read), public: read(${JSON.stringify(original)}), archive: read(${JSON.stringify(archive)}),
        writable: [write('own.txt'), write('/tmp/pi-sandbox-temp'), write(${JSON.stringify(original)}), write('/etc/pi-sandbox-test')],
        parentEnv: read('/proc/1/environ'), pidNamespace: fs.readlinkSync('/proc/self/ns/pid'),
        privateEnv: process.env.PI_PRIVATE_SECRET, url: process.env.COMFYUI_URL, explicit: process.env.TOOL_VAR,
        peers: fs.readdirSync(${JSON.stringify(path.dirname(env.cwd))})
      }));`;
    const result = await env.exec([process.execPath, "-e", script], { env: { TOOL_VAR: "explicit" }, onOutput: text => { output += text; } }, context);
    expect(result, output).toMatchObject({ ok: true, value: { exitCode: 0 } });
    const report = JSON.parse(output.trim());
    expect(report.contents.every((s: string) => s === "" || s === "DENIED")).toBe(true);
    expect(report.public).toBe("public-content");
    expect(report.archive).toBe('{"thread_id":"ids-only"}');
    expect(report.writable).toEqual([true, true, false, false]);
    expect(report.parentEnv).not.toContain(secret);
    expect(report.pidNamespace).not.toBe(hostPidNamespace);
    expect(report.privateEnv).toBeUndefined();
    expect(report.url).toBeUndefined();
    expect(report.explicit).toBe("explicit");
    expect(report.peers).toEqual(["group_7"]);
    expect(await fs.readFile(path.join(env.cwd, "own.txt"), "utf8")).toBe("changed");
    expect(await fs.readFile(original, "utf8")).toBe("public-content");
  });

  it("保留 loopback 网络并把 shell 超时/取消传递给进程树", async () => {
    const { env } = await fixture();
    const server = createServer((_req, res) => res.end("network-ok"));
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
    const port = (server.address() as { port: number }).port;
    let output = "";
    expect(await env.exec([process.execPath, "-e", `fetch('http://127.0.0.1:${port}').then(r=>r.text()).then(console.log)`],
      { onOutput: text => { output += text; } }, context), output).toMatchObject({ ok: true, value: { exitCode: 0 } });
    expect(output.trim()).toBe("network-ok");
    expect(await env.exec("sleep 20", { timeout: 0.1 }, context)).toMatchObject({ ok: false, error: { code: "timeout" } });
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 150);
    try {
      expect(await env.exec("sleep 20", undefined, withAbortSignal(abort.signal, context))).toMatchObject({ ok: false, error: { code: "aborted" } });
    } finally { clearTimeout(timer); }
  });
});
