import { promises as fs } from "node:fs";
import path from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { ExecutionError } from "@earendil-works/pi-durable/env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { codingEnvironment } from "../../src/agent/pi-tools/coding.js";
import * as sandbox from "../../src/agent/pi-tools/sandbox.js";
import { sandboxFixture } from "./pi-sandbox-fixture.js";

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("pi 内置工具执行环境", () => {
  it("首次创建会话目录并拒绝无效身份、跨域 access 与路径票据", async () => {
    for (const key of ["owner", "group:7", "private:9"]) {
      const { dir, env, options } = await sandboxFixture(key);
      expect(env).toBeInstanceOf(NodeExecutionEnv);
      expect(env.cwd).toBe(path.join(dir, "pi-work", key.replace(":", "_")));
      expect((await fs.stat(env.cwd)).isDirectory()).toBe(true);
      await expect(codingEnvironment({ ...options, key: "../escape" })).rejects.toThrow(/会话键/);
      await expect(codingEnvironment({ ...options, request: { ticket: "t", access: "group:8" } })).rejects.toThrow(/访问范围/);
      await expect(codingEnvironment({ ...options, request: { ...options.request, ticket: "../escape" } })).rejects.toThrow(/票据/);
    }
  });

  it("关闭继承、保留显式变量，并限制超时；命令只作为 bwrap argv 传入", async () => {
    vi.spyOn(sandbox, "requireBwrap").mockResolvedValue();
    const exec = vi.spyOn(NodeExecutionEnv.prototype, "exec").mockResolvedValue({ ok: true, value: { exitCode: 0 } });
    const { env } = await sandboxFixture();
    vi.stubEnv("NAPCAT_TOKEN", "secret");
    for (const [timeout, expected] of [[undefined, 60], [600, 60], [0.1, 0.1], [NaN, 60], [Infinity, 60], [0, 60]] as const) {
      await env.exec("echo '$(touch bad)'", { timeout, inheritEnv: true, env: { TOOL_VAR: "explicit" } }, context);
      const [command, options] = exec.mock.calls.at(-1)!;
      expect(command[0]).toBe("/usr/bin/bwrap");
      expect((command as string[]).slice(-5)).toEqual(["/bin/bash", "--noprofile", "--norc", "-c", "echo '$(touch bad)'"]);
      expect(options).toMatchObject({ timeout: expected, inheritEnv: false, env: { TOOL_VAR: "explicit" } });
      expect(options!.env).not.toHaveProperty("NAPCAT_TOKEN");
    }
    await env.exec(["/bin/echo", "a b", "--unshare-net"], undefined, context);
    expect((exec.mock.calls.at(-1)![0] as string[]).slice(-4)).toEqual(["--", "/bin/echo", "a b", "--unshare-net"]);
  });

  it("继承变量严格等于设计白名单，工具 env 可以新增和覆盖变量", async () => {
    vi.spyOn(sandbox, "requireBwrap").mockResolvedValue();
    const exec = vi.spyOn(NodeExecutionEnv.prototype, "exec").mockResolvedValue({ ok: true, value: { exitCode: 0 } });
    const { env } = await sandboxFixture();
    const allowed = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "TZ", "TERM", "TMPDIR"];
    for (const name of allowed) vi.stubEnv(name, "fixture-" + name);
    for (const name of ["COMFYUI_URL", "NODE_OPTIONS", "BASH_ENV", "ENV", "LD_PRELOAD", "TMP", "TEMP", "LC", "PUBLIC"]) vi.stubEnv(name, "excluded");
    await env.exec("true", { env: { TOOL_KEY: "explicit", LANG: "override" } }, context);
    const actual = exec.mock.calls[0]![1]!.env!;
    expect(actual).toMatchObject({ ...Object.fromEntries(allowed.map(k => [k, "fixture-" + k])), LANG: "override", TOOL_KEY: "explicit" });
    expect(Object.keys(actual).every(k => allowed.includes(k) || k.startsWith("LC_") || k === "TOOL_KEY")).toBe(true);
  });

  it.each(["missing", "empty", "invalid", "unreadable"])("deny_read %s 时返回错误且不启动任何进程", async kind => {
    vi.spyOn(sandbox, "requireBwrap").mockResolvedValue();
    const exec = vi.spyOn(NodeExecutionEnv.prototype, "exec");
    const { env, requirementsFile } = await sandboxFixture();
    if (kind === "missing" || kind === "unreadable") {
      await fs.unlink(requirementsFile);
      if (kind === "unreadable") await fs.mkdir(requirementsFile);
    } else await fs.writeFile(requirementsFile, kind === "empty" ? "[permissions.filesystem]\ndeny_read = []" : "broken", "utf8");
    expect(await env.exec("touch should-not-exist", undefined, context)).toMatchObject({ ok: false, error: { code: "spawn_error" } });
    expect(exec).not.toHaveBeenCalled();
    expect(await env.readTextFile(requirementsFile, context)).toMatchObject({ ok: false });
    expect(await env.writeFile("note.txt", "x", context)).toMatchObject({ ok: false });
  });

  it("bwrap 缺失及启动被拒绝均不退回裸跑", async () => {
    const probe = vi.spyOn(sandbox, "requireBwrap").mockRejectedValue(new Error("ENOENT /usr/bin/bwrap"));
    const exec = vi.spyOn(NodeExecutionEnv.prototype, "exec").mockResolvedValue({ ok: false, error: new ExecutionError("spawn_error", "EPERM") });
    const { env } = await sandboxFixture();
    expect(await env.exec("true", undefined, context)).toMatchObject({ ok: false });
    expect(exec).not.toHaveBeenCalled();
    probe.mockResolvedValue();
    expect(await env.exec("true", undefined, context)).toMatchObject({ ok: false });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls[0]![0][0]).toBe(sandbox.BWRAP);
  });

  it.runIf(process.platform !== "linux")("非 Linux 真实调用直接拒绝", async () => {
    const exec = vi.spyOn(NodeExecutionEnv.prototype, "exec");
    const { env } = await sandboxFixture();
    expect(await env.exec("true", undefined, context)).toMatchObject({ ok: false, error: { message: expect.stringContaining("Linux bwrap") } });
    expect(exec).not.toHaveBeenCalled();
  });
});
