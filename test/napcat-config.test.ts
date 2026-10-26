import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
const script = path.join(root, "scripts", "napcat-config.ps1");
const shells = ["pwsh", "powershell"].filter(command =>
  spawnSync(command, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "exit 0"], { timeout: 10000 }).status === 0,
);
const shell = shells[0];
const dirs: string[] = [];
function fixture(env: string) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cs-napcat-"));
  dirs.push(dir);
  writeFileSync(path.join(dir, ".env"), env, "utf8");
  return dir;
}
function run(dir: string) {
  return spawnSync(shell!, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-Root", dir], {
    cwd: dir, encoding: "utf8", timeout: 15000,
  });
}
function configPath(dir: string, name = "onebot11.json") { return path.join(dir, "napcat", "config", name); }
function readConfig(file: string) { return JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, "")); }
function successful(dir: string) {
  const result = run(dir);
  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  return result.stdout;
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

// 探测可执行性：例如沙箱禁止 pwsh 时继续尝试 Windows PowerShell 5.1。
describe.skipIf(!shell)("NapCat 播种脚本（无可用 PowerShell 时跳过）", () => {
  it.each(shells)("%s 不传 -Root 时以脚本父目录为根，不依赖当前目录", command => {
    const dir = fixture("NAPCAT_TOKEN=default-root-token\nQQ_BOT_ACCOUNT=123456\n");
    const scripts = path.join(dir, "scripts"); mkdirSync(scripts);
    const copied = path.join(scripts, "napcat-config.ps1"); copyFileSync(script, copied);
    const cwd = path.join(dir, "elsewhere"); mkdirSync(cwd);
    const result = spawnSync(command, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", copied], {
      cwd, encoding: "utf8", timeout: 15000,
    });
    expect(result.error).toBeUndefined(); expect(result.stderr).toBe(""); expect(result.status).toBe(0);
    for (const name of ["onebot11.json", "onebot11_123456.json"]) {
      const config = readConfig(configPath(dir, name));
      expect(config.network.httpServers[0].token).toBe("default-root-token");
      expect(config.network.websocketServers[0].token).toBe("default-root-token");
    }
    expect(existsSync(path.join(cwd, "napcat"))).toBe(false);
  });

  it("生成两份 UTF-8 无 BOM 配置，启用 HTTP/WS 并注入字面量 token", () => {
    const token = 'test-$token#="中文"';
    const dir = fixture(`NAPCAT_TOKEN='${token}' # 注释\nQQ_BOT_ACCOUNT="123456"\n`);
    const output = successful(dir);
    expect(output).not.toContain(token);
    const expected = {
      network: {
        httpServers: [{ enable: true, name: "agent-http", host: "0.0.0.0", port: 3000, enableCors: false, enableWebsocket: false, messagePostFormat: "array", token, debug: false }],
        httpSseServers: [], httpClients: [],
        websocketServers: [{ enable: true, name: "agent-ws", host: "0.0.0.0", port: 3001, reportSelfMessage: false, enableForcePushEvent: true, messagePostFormat: "array", token, debug: false, heartInterval: 30000 }],
        websocketClients: [], plugins: [],
      },
      musicSignUrl: "", enableLocalFile2Url: false, parseMultMsg: false, imageDownloadProxy: "",
      timeout: { baseTimeout: 10000, uploadSpeedKBps: 256, downloadSpeedKBps: 256, maxTimeout: 1800000 },
    };
    for (const name of ["onebot11.json", "onebot11_123456.json"]) {
      const file = configPath(dir, name);
      const bytes = readFileSync(file);
      expect(bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(false);
      expect(new TextDecoder("utf-8", { fatal: true }).decode(bytes)).toContain("中文");
      expect(readConfig(file)).toEqual(expected);
    }
    const files = readdirSync(path.dirname(configPath(dir)));
    const before = files.map(name => ({ bytes: readFileSync(configPath(dir, name)), mtime: statSync(configPath(dir, name)).mtimeMs }));
    expect(successful(dir).match(/unchanged:/g)).toHaveLength(2);
    expect(readdirSync(path.dirname(configPath(dir)))).toEqual(files);
    files.forEach((name, i) => {
      expect(readFileSync(configPath(dir, name))).toEqual(before[i]!.bytes);
      expect(statSync(configPath(dir, name)).mtimeMs).toBe(before[i]!.mtime);
    });
  });

  it("token 区分大小写；逐份备份原字节，只修改受管服务的 token", () => {
    const dir = fixture("NAPCAT_TOKEN=before\nQQ_BOT_ACCOUNT=123456\n");
    successful(dir);
    const names = ["onebot11.json", "onebot11_123456.json"];
    const originals = names.map((name, i) => {
      const file = configPath(dir, name);
      const config = readConfig(file);
      config.network.httpServers[0].port = 3333;
      config.network.websocketServers[0].debug = true;
      config.network.plugins = [{ token: "unrelated", note: '保留自定义配置 {"token":"before"}' }];
      config.network.httpServers.unshift({ name: "unmanaged", token: "unrelated-http", nested: { token: "unrelated-nested" } });
      const newline = i ? "\r\n" : "\n";
      writeFileSync(file, (i ? "\uFEFF" : "") + JSON.stringify(config, null, 2).replace(/\n/g, newline) + newline, "utf8");
      return { config, bytes: readFileSync(file) };
    });
    writeFileSync(path.join(dir, ".env"), "NAPCAT_TOKEN=BEFORE\nQQ_BOT_ACCOUNT=123456\n", "utf8");
    expect(successful(dir).match(/backup:/g)).toHaveLength(2);
    names.forEach((name, i) => {
      const backup = readdirSync(path.dirname(configPath(dir))).filter(n => n.startsWith(`${name}.bak-`));
      expect(backup).toHaveLength(1);
      expect(readFileSync(configPath(dir, backup[0]))).toEqual(originals[i]!.bytes);
      const expected = originals[i]!.config;
      expected.network.httpServers[1].token = "BEFORE";
      expected.network.websocketServers[0].token = "BEFORE";
      expect(readConfig(configPath(dir, name))).toEqual(expected);
      const updated = readFileSync(configPath(dir, name), "utf8");
      expect(updated).toBe(originals[i]!.bytes.toString("utf8").replaceAll('"token": "before"', '"token": "BEFORE"'));
      expect(updated.startsWith("\uFEFF")).toBe(Boolean(i));
      expect(updated.includes("\r\n")).toBe(Boolean(i));
      if (i) expect(updated.replace(/\r\n/g, "")).not.toContain("\n");
    });
    expect(successful(dir).match(/unchanged:/g)).toHaveLength(2);
    expect(readdirSync(path.dirname(configPath(dir))).filter(n => n.includes(".bak-"))).toHaveLength(2);
  });

  it("账号为空时只写通用配置，并解析双引号与行尾注释", () => {
    const dir = fixture('export NAPCAT_TOKEN="test=token" # 注释\nQQ_BOT_ACCOUNT=\n');
    successful(dir);
    expect(readdirSync(path.dirname(configPath(dir)))).toEqual(["onebot11.json"]);
    expect(readConfig(configPath(dir)).network.httpServers[0].token).toBe("test=token");
  });

  it.each(["", "NAPCAT_TOKEN=", "NAPCAT_TOKEN= # 请填写", "NAPCAT_TOKEN='  '", "NAPCAT_TOKEN=test\nQQ_BOT_ACCOUNT=../../escape"])("拒绝无效输入且不创建目录：%j", env => {
    const dir = fixture(env);
    expect(run(dir).status).toBe(1);
    expect(existsSync(path.join(dir, "napcat"))).toBe(false);
  });

  it("缺少 .env 时失败且不创建目录", () => {
    const dir = fixture("");
    rmSync(path.join(dir, ".env"));
    expect(run(dir).status).toBe(1);
    expect(existsSync(path.join(dir, "napcat"))).toBe(false);
  });

  it("已有配置损坏时不覆盖、不备份，也不部分更新其它配置或泄露原文", () => {
    const dir = fixture("NAPCAT_TOKEN=old\nQQ_BOT_ACCOUNT=123456\n");
    successful(dir);
    const original = readFileSync(configPath(dir));
    const invalid = '{"secret":"do-not-print", broken}';
    writeFileSync(configPath(dir, "onebot11_123456.json"), invalid, "utf8");
    writeFileSync(path.join(dir, ".env"), "NAPCAT_TOKEN=new\nQQ_BOT_ACCOUNT=123456\n", "utf8");
    const result = run(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain("do-not-print");
    expect(readFileSync(configPath(dir))).toEqual(original);
    expect(readFileSync(configPath(dir, "onebot11_123456.json"), "utf8")).toBe(invalid);
    expect(readdirSync(path.dirname(configPath(dir)))).toHaveLength(2);
  });
});

// Windows 的 docker 可能是 .cmd 包装器；只执行固定参数的只读 config 命令。
function docker(args: string[], env = process.env) {
  const options = { cwd: root, encoding: "utf8" as const, timeout: 15000, env };
  // 参数均为下方固定字面量，不拼接路径、口令或外部输入。
  return process.platform === "win32"
    ? spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `docker ${args.join(" ")}`], options)
    : spawnSync("docker", args, options);
}
const hasCompose = process.env.CS_TEST_SKIP_DOCKER !== "1" && docker(["compose", "version"]).status === 0;
it.skipIf(!hasCompose)("docker compose config --quiet 可解析（无可用 Docker Compose 时跳过）", () => {
  const result = docker(["compose", "-f", "docker-compose.yml", "config", "--quiet"], { ...process.env, NAPCAT_WEBUI_TOKEN: "test-webui-token" });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
});
