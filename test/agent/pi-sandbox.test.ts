import { promises as fs } from "node:fs";
import path from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bwrapArgs, expandDenyRead, loadDenyRead, parseDenyRead } from "../../src/agent/pi-tools/sandbox.js";
import { codingEnvironment } from "../../src/agent/pi-tools/coding.js";
import { put, sandboxFixture } from "./pi-sandbox-fixture.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("受管 deny_read", () => {
  it("直接解析 entrypoint.sh 的实际受管模板，避免测试夹具与 Codex 配置漂移", async () => {
    const script = await fs.readFile(new URL("../../scripts/entrypoint.sh", import.meta.url), "utf8");
    const managed = script.match(/\[permissions\.filesystem\]\r?\ndeny_read\s*=\s*\[[\s\S]*?\r?\n\]/)?.[0];
    expect(managed).toBeDefined();
    const rules = parseDenyRead(managed!.replaceAll("$C", "/fixture-data/codex").replaceAll("$D", "/fixture-data"));
    for (const file of ["/fixture-data/*.sqlite*", "/fixture-data/codex/*.sqlite*", "/fixture-data/obs-token", "/fixture-data/media", "/fixture-data/codex/trace"]) {
      expect(rules).toContain(path.normalize(file));
    }
  });
  it("解析注释、字符串、转义、CRLF、尾逗号并只读取 filesystem 表", async () => {
    const { dir } = await sandboxFixture();
    const file = path.join(dir, "中文#文件");
    const literal = path.join(dir, "literal");
    expect(parseDenyRead(`[other]\ndeny_read = [\"/ignore\"]\n# deny_read = []\n[permissions.filesystem]\r\ndeny_read = [\r\n${JSON.stringify(file)}, # 注释\r\n'${literal}',\n]\n[other.next]\nx = true\n`)).toEqual([file, literal]);
  });
  it.each(["", "[permissions.filesystem]\ndeny_read=[]", "[other]\ndeny_read=['/a']",
    "[permissions.filesystem]\ndeny_read=['relative']", "[permissions.filesystem]\ndeny_read=[1]",
    "[permissions.filesystem]\ndeny_read=['/a' '/b']", "[permissions.filesystem]\ndeny_read=['/a']\ndeny_read=['/b']",
    "[permissions.filesystem]\ndeny_read=['/a']\n[permissions.filesystem]\ndeny_read=['/b']",
    "[permissions.filesystem]\ndeny_read=['/a'] garbage", "[permissions.filesystem]\ndeny_read=['/a/{b,c}']",
  ])("非法配置关闭权限：%s", value => { expect(() => parseDenyRead(value)).toThrow(); });
  it("展开 *、?、**，含 SQLite sidecar；忽略不存在项并合并目录子项", async () => {
    const { dir } = await sandboxFixture();
    const files = await Promise.all(["a.sqlite", "a.sqlite-wal", "a.sqlite-shm", "nested/token1", "nested/sub/token2", ".hidden.sqlite", "nested/.hidden/token3", "private/a"].map(p => put(path.join(dir, p))));
    const matches = await expandDenyRead([path.join(dir, "*.sqlite*"), path.join(dir, "nested/**/token?"), path.join(dir, "missing*"), path.join(dir, "absent"), path.join(dir, "private"), path.join(dir, "private/a")]);
    expect(matches.filter(m => !m.directory).map(m => m.path).sort()).toEqual(files.slice(0, 7).sort());
    expect(matches.filter(m => m.directory)).toEqual([{ path: path.join(dir, "private"), directory: true }]);
  });
  it("尊重 CODEX_REQUIREMENTS_FILE 且不会缓存成功后丢失的文件", async () => {
    const { requirementsFile } = await sandboxFixture();
    vi.stubEnv("CODEX_REQUIREMENTS_FILE", requirementsFile);
    expect((await loadDenyRead()).patterns.length).toBeGreaterThan(0);
    await fs.unlink(requirementsFile);
    await expect(loadDenyRead()).rejects.toThrow();
  });
  it("损坏的 UTF-8 与展开期间的权限错误不能被吞掉", async () => {
    const { dir, requirementsFile } = await sandboxFixture();
    await fs.writeFile(requirementsFile, Buffer.from([0xff, 0xfe]));
    await expect(loadDenyRead(requirementsFile)).rejects.toThrow();
    const file = await put(path.join(dir, "denied"));
    vi.spyOn(fs, "stat").mockRejectedValue(Object.assign(new Error("denied"), { code: "EACCES" }));
    await expect(expandDenyRead([file])).rejects.toThrow("denied");
  });
});

describe("Pi 文件策略", () => {
  it("技能目录对任何发送者都只读（写技能走 skill_publish）", async () => {
    const { dir, options } = await sandboxFixture();
    const file = path.join(dir, "skills", "hello", "SKILL.md");
    await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, "技能");
    for (const senderIsOwner of [true, false]) {
      const env = await codingEnvironment({ ...options, request: { ...options.request, senderIsOwner } });
      expect(await env.writeFile(file, "不准", context)).toMatchObject({ ok: false });
    }
  });
  it("完整拒绝配置的 Codex 工作区与 trace，ID 归档仍可读", async () => {
    const { dir, workspaceDir, env } = await sandboxFixture();
    // 目录尚未创建时也拒绝；之后新增的 scope 在下一次调用中纳入 bwrap 遮蔽。
    await expect(env.policy.check(path.join(workspaceDir, "group_8", "note"), "read")).rejects.toThrow("拒绝");
    const files = await Promise.all([
      put(path.join(workspaceDir, "group_8", "note")), put(path.join(workspaceDir, "owner", "note")),
      put(path.join(dir, "codex", "trace", "x.json")),
    ]);
    for (const file of files) {
      expect(await env.readTextFile(file, context)).toMatchObject({ ok: false, error: { code: "permission_denied" } });
      expect(await env.writeFile(file, "bad", context)).toMatchObject({ ok: false });
    }
    const deny = await env.policy.deny();
    for (const root of [workspaceDir, path.join(dir, "codex", "trace")]) {
      expect(deny.patterns).toContain(root);
      expect(deny.paths).toContainEqual({ path: root, directory: true });
      expect(bwrapArgs(env.cwd, env.policy.workRoot, deny.paths, "true").join(" ")).toContain("--tmpfs " + root + " --remount-ro " + root);
    }
    const archive = await put(path.join(dir, "codex-threads-archive.jsonl"), '{"thread_id":"ids-only"}');
    expect(await env.readTextFile(archive, context)).toMatchObject({ ok: true, value: '{"thread_id":"ids-only"}' });
    expect(deny.patterns).not.toContain(archive);
    expect(await env.readTextFile(await put(path.join(workspaceDir + "-public", "note"), "public"), context)).toMatchObject({ ok: true, value: "public" });
  });
  it("Codex 工作区链接的真实目标同样禁读，会话图片例外不能覆盖它", async () => {
    const { dir, workspaceDir, env, options } = await sandboxFixture();
    const target = path.join(dir, "images", "group_7");
    const file = await put(path.join(target, "secret"));
    await fs.symlink(target, workspaceDir, process.platform === "win32" ? "junction" : "dir");
    const deny = await env.policy.deny();
    expect(deny.patterns).toEqual(expect.arrayContaining([workspaceDir, target]));
    expect(deny.paths).toContainEqual({ path: target, directory: true });
    for (const p of [file, path.join(workspaceDir, "secret")]) {
      expect(await env.readTextFile(p, context)).toMatchObject({ ok: false });
      expect(await env.writeFile(p, "bad", context)).toMatchObject({ ok: false });
    }
    const nested = await codingEnvironment({ ...options, workspaceDir: path.join(workspaceDir, "future") });
    await expect(nested.policy.check(path.join(target, "future", "note"), "read")).rejects.toThrow("拒绝");
  });
  it("默认文件可读；禁读库、票据、其他会话及主进程 proc 不可读", async () => {
    const { dir, env } = await sandboxFixture();
    for (const file of ["qq-messages.sqlite", "qq-messages.sqlite-wal", ".hidden.sqlite", "obs-token", "codex/auth.json", "tickets/other.json", "pi-work/group_8/note", "pi.sqlite-shm", "pi-threads.json"]) {
      const target = await put(path.join(dir, file));
      expect(await env.readTextFile(target, context), file).toMatchObject({ ok: false, error: { code: "permission_denied" } });
    }
    for (const file of ["/proc/1/environ", "/proc/self/environ", "/dev/fd/3", "/sys/kernel"]) {
      expect(await env.readTextFile(file, context), file).toMatchObject({ ok: false });
    }
    const publicFile = await put(path.join(dir, "public", "hello"), "public");
    expect(await env.readTextFile(publicFile, context)).toMatchObject({ ok: true, value: "public" });
    expect(await env.readTextFile(path.join(dir, "pi-work"), context)).toMatchObject({ ok: false });
  });
  it("按范围授权媒体文件，不能列目录；只有本轮输入的 incoming 与本会话 images 例外", async () => {
    const { dir, env, store } = await sandboxFixture();
    const own = await put(path.join(dir, "media", "own.png"));
    const other = await put(path.join(dir, "media", "other.png"));
    const allowed = vi.spyOn(store, "mediaPathAllowed").mockImplementation((access, file) => (access as { scope: string }).scope === "group:7" && file === own);
    expect(await env.readBinaryFile(own, context)).toMatchObject({ ok: true });
    expect(allowed).toHaveBeenCalledWith({ kind: "scope", scope: "group:7" }, own);
    expect(await env.readBinaryFile(other, context)).toMatchObject({ ok: false });
    expect(await env.listDir(path.join(dir, "media"), context)).toMatchObject({ ok: false });
    for (const [own, other] of [["incoming/ticket-7", "incoming/ticket-8"], ["images/group_7", "images/group_8"]]) {
      expect(await env.readTextFile(await put(path.join(dir, own!, "a")), context)).toMatchObject({ ok: true });
      expect(await env.readTextFile(await put(path.join(dir, other!, "a")), context)).toMatchObject({ ok: false });
    }
    const owner = await codingEnvironment({ ...env.policy.options, key: "owner", request: { access: "all", inputs: [] } });
    allowed.mockImplementation(access => (access as { kind: string }).kind === "all");
    expect(await owner.readBinaryFile(other, context)).toMatchObject({ ok: true });
  });
  it("写入只限当前工作区与本会话 images，缺失的嵌套目录可创建", async () => {
    const { dir, env } = await sandboxFixture();
    for (const file of [path.join(env.cwd, "new", "nested", "a.txt"), path.join(dir, "images", "group_7", "new.png")]) {
      expect(await env.writeFile(file, "ok", context)).toMatchObject({ ok: true });
      expect(await fs.readFile(file, "utf8")).toBe("ok");
    }
    for (const file of ["prompts/agent.md", "incoming/ticket-7/a", "images/group_8/a", "pi-work/group_8/a", "pi-work/group_7-extra/a", "outside"]) {
      expect(await env.writeFile(path.join(dir, file), "bad", context), file).toMatchObject({ ok: false });
    }
    expect(await env.writeFile("../group_8/a", "bad", context)).toMatchObject({ ok: false });
  });
  it("全部文件入口执行同一策略，包括流式读取、元数据与双端重命名", async () => {
    const { dir, env } = await sandboxFixture();
    const secret = await put(path.join(dir, "obs-token"));
    const reads = [env.readTextFile(secret, context), env.readTextLines(secret, undefined, context), env.openTextLineReader(secret, context),
      env.readBinaryFile(secret, context), env.openBinaryReader(secret, undefined, context), env.fileInfo(secret, context),
      env.exists(secret, context), env.canonicalPath(secret, context), env.listDir(secret, context), env.openDirReader(secret, context)];
    for (const result of await Promise.all(reads)) expect(result).toMatchObject({ ok: false, error: { code: "permission_denied" } });
    const writes = [env.writeFile(secret, "bad", context), env.appendFile(secret, "bad", context), env.truncateFile(secret, 0, context),
      env.flushFile(secret, context), env.createDir(secret, undefined, context), env.remove(secret, undefined, context),
      env.renameFile(secret, "copied", context), env.renameFile("copied", secret, context)];
    for (const result of await Promise.all(writes)) expect(result).toMatchObject({ ok: false });
    expect(await fs.readFile(secret, "utf8")).toBe("private-content");
    const temp = await env.createTempFile(undefined, context);
    expect(temp).toMatchObject({ ok: true, value: expect.stringContaining(env.cwd) });
    expect(await env.createTempDir("../escape", context)).toMatchObject({ ok: false });
    expect(await env.createTempFile({ suffix: "/../../escape" }, context)).toMatchObject({ ok: false });
    expect(await env.watch([{ path: dir, recursive: true }], () => {}, context)).toMatchObject({ ok: false });
  });
  it("realpath 阻止目录链接、会话图片根链接及悬空链接逃逸", async () => {
    const { dir, env } = await sandboxFixture();
    const outside = path.join(dir, "private");
    await put(path.join(outside, "token"));
    const link = path.join(env.cwd, "link");
    await fs.symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
    expect(await env.writeFile(path.join(link, "new"), "bad", context)).toMatchObject({ ok: false });
    const deniedDir = path.join(dir, "tickets");
    await put(path.join(deniedDir, "answer"));
    const alias = path.join(env.cwd, "alias");
    await fs.symlink(deniedDir, alias, process.platform === "win32" ? "junction" : "dir");
    expect(await env.readTextFile(path.join(alias, "answer"), context)).toMatchObject({ ok: false });
    await fs.mkdir(path.join(dir, "images"), { recursive: true });
    await fs.symlink(outside, path.join(dir, "images", "group_7"), process.platform === "win32" ? "junction" : "dir");
    expect(await env.writeFile(path.join(dir, "images", "group_7", "new"), "bad", context)).toMatchObject({ ok: false });
    const dangling = path.join(env.cwd, "dangling");
    await fs.symlink(path.join(dir, "not-yet-created"), dangling, process.platform === "win32" ? "junction" : "dir");
    expect(await env.writeFile(path.join(dangling, "new"), "bad", context)).toMatchObject({ ok: false });
  });
  it("文件列表过滤禁读子项，非受管文件可见", async () => {
    const { dir, env } = await sandboxFixture();
    await put(path.join(dir, "obs-token"));
    await put(path.join(dir, "visible"));
    const listing = await env.listDir(dir, context);
    expect(listing.ok && listing.value.map(info => info.name)).not.toContain("obs-token");
    expect(listing.ok && listing.value.map(info => info.name)).toContain("visible");
    const opened = await env.openDirReader(dir, context);
    expect(opened.ok).toBe(true);
    if (opened.ok) {
      try {
        const page = await opened.value.next(100, context);
        expect(page.ok && page.value.entries.map(info => info.name)).not.toContain("obs-token");
      } finally { await opened.value.close(context); }
    }
  });
});

describe("bwrap 参数", () => {
  it("没有可写的技能挂载：只挂回当前会话工作区", () => {
    const args = bwrapArgs("/data/pi-work/group_7", "/data/pi-work", [], "true");
    expect(args.filter(a => a === "--bind")).toHaveLength(1);
    expect(args.join(" ")).not.toContain("/data/skills");
  });
  it("只挂回当前会话、隔离 pid/proc、保留网络，目录与文件分别遮蔽", () => {
    const args = bwrapArgs("/data/pi-work/group_7", "/data/pi-work", [
      { path: "/data/media", directory: true }, { path: "/data/pi.sqlite", directory: false },
    ], "cat /proc/1/environ");
    for (const flag of ["--unshare-user", "--unshare-pid", "--die-with-parent", "--new-session"]) expect(args).toContain(flag);
    expect(args).not.toContain("--unshare-net");
    expect(args).not.toContain("--unshare-all");
    const joined = args.join(" ");
    expect(joined).toContain("--ro-bind / / --proc /proc --remount-ro /proc");
    expect(joined).toContain("--tmpfs /tmp");
    expect(joined).toContain("--tmpfs /data/pi-work --bind /data/pi-work/group_7 /data/pi-work/group_7 --remount-ro /data/pi-work");
    expect(joined).toContain("--tmpfs /data/media --remount-ro /data/media");
    expect(joined).toContain("--ro-bind /dev/null /data/pi.sqlite");
    expect(args.filter(a => a === "--bind")).toHaveLength(1);
  });
});
