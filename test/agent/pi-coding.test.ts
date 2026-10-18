import { promises as fs } from "node:fs";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { afterEach, describe, expect, it, vi } from "vitest";
import { codingEnvironment, PiExecutionEnv } from "../../src/agent/pi-tools/coding.js";
import { registerSecrets } from "../../src/obs/redact.js";
import { tmp } from "./helpers.js";

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("pi 内置工具执行环境", () => {
  it("首次创建会话工作目录，非法键不能用于拼接路径", async () => {
    const dir = tmp();
    await expect(fs.access(path.join(dir, "pi-work"))).rejects.toThrow();
    for (const key of ["owner", "group:7", "private:9"]) {
      const env = await codingEnvironment(dir, key);
      expect(env).toBeInstanceOf(NodeExecutionEnv);
      expect(env.cwd).toBe(path.join(dir, "pi-work", key.replace(":", "_")));
      expect((await fs.stat(env.cwd)).isDirectory()).toBe(true);
    }
    await expect(codingEnvironment(dir, "../escape")).rejects.toThrow(/会话键/);
  });

  it("真实 bash 子进程不继承凭据名、面板口令或普通变量中的已注册秘密", async () => {
    const names = ["NAPCAT_TOKEN", "DEEPSEEK_API_KEY", "DEEPSEEK_APIKEY", "OBS_TOKEN", "DASHBOARD_PASSWORD", "PI_ALIAS"];
    for (const key of names) vi.stubEnv(key, "fixture-credential-" + key);
    registerSecrets([process.env.PI_ALIAS]);
    vi.stubEnv("PI_PUBLIC", "visible");
    const env = new PiExecutionEnv({ cwd: tmp() });
    let output = "";
    const command = "printf '%s' \"" + names.map(k => "${" + k + "-unset}").join("|") + "|${PI_PUBLIC}\"";
    const result = await env.exec(command, { inheritEnv: true, onOutput: text => { output += text; } }, BACKGROUND_CONTEXT);
    expect(result).toMatchObject({ ok: true, value: { exitCode: 0 } });
    expect(output).toBe(names.map(() => "unset").join("|") + "|visible");
    await env.cleanup(BACKGROUND_CONTEXT);
  });

  it("无论调用方参数如何，关闭继承并把超时上限钳在 60 秒", async () => {
    const exec = vi.spyOn(NodeExecutionEnv.prototype, "exec").mockResolvedValue({ ok: true, value: { exitCode: 0 } });
    const env = new PiExecutionEnv({ cwd: tmp() });
    for (const [timeout, expected] of [[undefined, 60], [600, 60], [0.1, 0.1]] as const) {
      await env.exec("true", { timeout, inheritEnv: true, env: { NAPCAT_TOKEN: "do-not-pass" } }, BACKGROUND_CONTEXT);
      expect(exec.mock.calls.at(-1)![1]).toMatchObject({ timeout: expected, inheritEnv: false });
      expect(exec.mock.calls.at(-1)![1]!.env).not.toHaveProperty("NAPCAT_TOKEN");
    }
  });
});
