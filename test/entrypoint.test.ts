import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { tmp } from "./agent/helpers.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hasSh = spawnSync("sh", ["-c", "true"]).status === 0;
const posix = (p: string) => p.replace(/\\/g, "/");

/** 用 sh 运行 entrypoint.sh（去掉 CR），参数 `true` 让它写完 config.toml 后直接退出。 */
/** sh 眼中的绝对路径：Windows（Git Bash/MSYS）上 C:\x → /c/x，POSIX 原样。 */
const shPath = (p: string) => (process.platform === "win32" ? posix(p).replace(/^([A-Za-z]):/, (_m, d: string) => `/${d.toLowerCase()}`) : p);

function runEntrypoint(env: Record<string, string>) {
  return runEntrypointIn(tmp("cs-entry-"), env);
}

function runEntrypointIn(
  dir: string,
  env: Record<string, string>,
  args: string[] = ["true"],
): { toml: string; requirements: string; stdout: string; stderr: string; status: number | null; dataDir: string } {
  const script = path.join(dir, "entrypoint.sh");
  writeFileSync(script, readFileSync(path.join(ROOT, "scripts", "entrypoint.sh"), "utf8").replace(/\r/g, ""));
  const data = path.join(dir, "data");
  const ws = path.join(dir, "ws");
  const r = spawnSync("sh", [posix(script), ...args], {
    env: {
      ...process.env, DATA_DIR: shPath(data), WORKSPACE_DIR: shPath(ws), WORKFLOWS_SRC: "/nonexistent",
      CODEX_REQUIREMENTS_FILE: shPath(path.join(dir, "etc-codex", "requirements.toml")), ...env,
    },
    encoding: "utf8",
  });
  let toml = "";
  try {
    toml = readFileSync(path.join(data, "codex", "config.toml"), "utf8");
  } catch {
    /* status 断言会报出问题 */
  }
  let requirements = "";
  try {
    requirements = readFileSync(path.join(dir, "etc-codex", "requirements.toml"), "utf8");
  } catch {
    /* 同上 */
  }
  return { toml, requirements, stdout: r.stdout, stderr: r.stderr, status: r.status, dataDir: shPath(data) };
}

/** 极简 TOML 读取：返回 { "section.key": value }，只覆盖本文件用到的语法。 */
function parse(toml: string): Record<string, string> {
  const out: Record<string, string> = {};
  let section = "";
  for (const raw of toml.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const sec = /^\[([^\]]+)\]$/.exec(line);
    if (sec) {
      section = sec[1]!;
      out[`[${section}]`] = "";
      continue;
    }
    const kv = /^([A-Za-z0-9_]+)\s*=\s*(.+)$/.exec(line);
    if (!kv) throw new Error(`unexpected TOML line: ${line}`);
    out[section ? `${section}.${kv[1]}` : kv[1]!] = kv[2]!;
  }
  return out;
}

describe.skipIf(!hasSh)("entrypoint.sh managed codex config", () => {
  it("writes model, web_search, qq_context and browser MCP sections with defaults", () => {
    const binDir = tmp("cs-pwbin-");
    const bin = path.join(binDir, "playwright-mcp");
    writeFileSync(bin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const { toml, status } = runEntrypoint({ PLAYWRIGHT_MCP_BIN: posix(bin), CODEX_MODEL: "", CODEX_WEB_SEARCH: "", CODEX_BROWSER: "" });
    expect(status).toBe(0);
    const t = parse(toml);
    expect(t).toMatchObject({
      model: '"gpt-6.1-sol"',
      model_reasoning_effort: '"high"',
      web_search: '"live"',
      "tools.web_search.context_size": '"low"',
      "mcp_servers.qq_context.command": '"node"',
      "mcp_servers.qq_context.args": '["/app/dist/mcp/qq-context.js"]',
      "mcp_servers.qq_context.startup_timeout_sec": "10",
      "mcp_servers.qq_context.tool_timeout_sec": "15",
      "mcp_servers.qq_context.env.QQ_CONTEXT_MAX_CHARS": '"2500"',
      "mcp_servers.browser.env.PLAYWRIGHT_BROWSERS_PATH": '"/opt/pw-browsers"',
    });
    const args = JSON.parse(t["mcp_servers.browser.args"]!) as string[];
    expect(args.slice(0, 4)).toEqual(["--headless", "--isolated", "--browser", "chromium"]);
    expect(args.at(-1)).toBe("--sandbox"); // 显式开启 Chromium 沙箱（Playwright 默认关闭）
    expect(args).not.toContain("--no-sandbox");
    const blocked = args[args.indexOf("--blocked-origins") + 1]!.split(";");
    for (const must of [
      "host.docker.internal", "host.docker.internal:*", "*.docker.internal:*", "localhost", "localhost:*", "[::1]:*",
      "127.*", "10.*", "192.168.*", "169.254.*", "0.0.0.0:*", ...Array.from({ length: 16 }, (_, i) => `172.${16 + i}.*`),
    ]) {
      expect(blocked).toContain(must);
    }
    expect(blocked).not.toContain("*");
    expect(t["mcp_servers.qq_context.env.DATA_DIR"]).toMatch(/^"\/[A-Za-z0-9._/-]+"$/);
    expect(t["mcp_servers.qq_context.env.QQ_ACCESS"]).toBeUndefined(); // 每轮由 -c 注入
    expect(t["mcp_servers.browser.command"]).toMatch(/playwright-mcp"$/);
  });

  it("writes [sandbox_workspace_write] with network and validated writable roots", () => {
    const def = parse(runEntrypoint({ CODEX_WRITABLE_ROOTS: "/workspace,/data/prompts,/data/workflows" }).toml);
    expect(def).toMatchObject({
      "sandbox_workspace_write.network_access": "true",
      "sandbox_workspace_write.writable_roots": '["/workspace", "/data/prompts", "/data/workflows"]',
    });
    // 默认值按实际 DATA_DIR / WORKSPACE_DIR 展开
    const d = runEntrypoint({});
    expect(parse(d.toml)["sandbox_workspace_write.writable_roots"]).toBe(
      `["${d.dataDir.replace(/data$/, "ws")}", "${d.dataDir}/prompts", "${d.dataDir}/workflows"]`,
    );
    // 拒绝：相对路径、/、DATA_DIR 本身、CODEX_HOME 及其子目录、图片目录、*.sqlite、.. 与非法字符
    const dir = tmp("cs-entry-");
    const data = shPath(path.join(dir, "data"));
    const roots = ["/workspace", " /srv/prompts/ ", "relative", "/", data, `${data}/`, `${data}/codex`, `${data}/codex/sessions`,
      `${data}/images`, `${data}/qq-messages.sqlite`, "/x/../etc", '/w"x', "/opt/ok"];
    const r = runEntrypointIn(dir, { CODEX_SANDBOX_NETWORK: "false", CODEX_WRITABLE_ROOTS: roots.join(",") });
    const t = parse(r.toml);
    expect(t["sandbox_workspace_write.network_access"]).toBe("false");
    expect(t["sandbox_workspace_write.writable_roots"]).toBe('["/workspace", "/srv/prompts", "/opt/ok"]');
    expect(r.stderr).toContain("rejected CODEX_WRITABLE_ROOTS entry 'relative'");
    expect(r.stderr).toContain(`rejected CODEX_WRITABLE_ROOTS entry '${data}/codex'`);
    expect(parse(runEntrypoint({ CODEX_SANDBOX_NETWORK: "maybe" }).toml)["sandbox_workspace_write.network_access"]).toBe("true");
  });

  it("normalizes writable roots before the forbidden-path check", () => {
    const dir = tmp("cs-entry-");
    const data = shPath(path.join(dir, "data"));
    const parent = data.replace(/\/data$/, "");
    const bad = [`${data}//`, `${data}/.`, `${data}/./`, `${data}/codex/.`, `${data}//codex`, `${data}/images//x`, `${data}/./images`,
      `${data}/x.sqlite/.`, "//", "/.", `${parent}`, `${parent}/`, `${data}/prompts/../codex`];
    const good = ["/srv//prompts/", "/srv/./wf/.", `${data}//workflows/`];
    const r = runEntrypointIn(dir, { CODEX_WRITABLE_ROOTS: [...bad, ...good].join(",") });
    expect(r.status).toBe(0);
    expect(parse(r.toml)["sandbox_workspace_write.writable_roots"]).toBe(`["/srv/prompts", "/srv/wf", "${data}/workflows"]`);
    for (const b of bad) expect(r.stderr).toContain(`rejected CODEX_WRITABLE_ROOTS entry '${b}'`);
  });

  it("exports the normalized, validated writable roots for rendering AGENTS.md", () => {
    const dir = tmp("cs-entry-");
    const data = shPath(path.join(dir, "data"));
    const r = runEntrypointIn(dir, { CODEX_WRITABLE_ROOTS: `/workspace/,${data}//workflows,${data}/codex` }, ["sh", "-c", 'printf %s "$CODEX_EFFECTIVE_WRITABLE_ROOTS"']);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`/workspace,${data}/workflows`);
  });

  it("writes the managed requirements.toml deny_read list for the codex command sandbox", () => {
    const r = runEntrypoint({});
    expect(r.status).toBe(0);
    const d = r.dataDir;
    expect(r.requirements).toContain("[permissions.filesystem]");
    const list = JSON.parse(/deny_read = (\[[\s\S]*?\])/.exec(r.requirements)![1]!.replace(/,\s*\]/, "]")) as string[];
    expect(list).toEqual(expect.arrayContaining([
      `${d}/codex/auth.json`, `${d}/codex/sessions`, `${d}/codex/*.sqlite*`, `${d}/codex/history.jsonl`,
      `${d}/*.sqlite*`, `${d}/images`, `${d}/codex-session.json`,
    ]));
    // 不能整个禁读 CODEX_HOME（codex 的 arg0 辅助程序在 $CODEX_HOME/tmp）；config.toml / AGENTS.md 可读
    expect(list).not.toContain(`${d}/codex`);
    expect(list.some((p) => p.endsWith("/tmp") || p.endsWith("config.toml") || p.endsWith("AGENTS.md"))).toBe(false);
  });

  it("refuses to start when requirements.toml cannot be written", () => {
    const dir = tmp("cs-entry-");
    const blocker = path.join(dir, "not-a-dir");
    writeFileSync(blocker, "x");
    const r = runEntrypointIn(dir, { CODEX_REQUIREMENTS_FILE: shPath(path.join(blocker, "requirements.toml")) });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("cannot write");
  });

  it("seeds DATA_DIR/workflows from WORKFLOWS_SRC once and never overwrites", () => {
    const src = tmp("cs-wf-");
    writeFileSync(path.join(src, "wf.json"), "{\"v\":1}");
    const dir = tmp("cs-entry-");
    const data = path.join(dir, "data");
    const env = { WORKFLOWS_SRC: posix(src) };
    runEntrypointIn(dir, env);
    expect(readFileSync(path.join(data, "workflows", "wf.json"), "utf8")).toBe("{\"v\":1}");
    writeFileSync(path.join(data, "workflows", "wf.json"), "edited by codex");
    writeFileSync(path.join(src, "wf.json"), "{\"v\":2}");
    runEntrypointIn(dir, env);
    expect(readFileSync(path.join(data, "workflows", "wf.json"), "utf8")).toBe("edited by codex");
  });

  it("drops --sandbox only when PLAYWRIGHT_NO_SANDBOX=1", () => {
    const binDir = tmp("cs-pwbin-");
    const bin = path.join(binDir, "playwright-mcp");
    writeFileSync(bin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const t = parse(runEntrypoint({ PLAYWRIGHT_MCP_BIN: posix(bin), PLAYWRIGHT_NO_SANDBOX: "1" }).toml);
    const args = JSON.parse(t["mcp_servers.browser.args"]!) as string[];
    expect(args).not.toContain("--sandbox");
    expect(args.at(-2)).toBe("--blocked-origins");
  });

  it("honours overrides, rejects invalid values, and omits the browser when disabled or missing", () => {
    const ok = parse(runEntrypoint({ CODEX_WEB_SEARCH: "cached", CODEX_WEB_SEARCH_CONTEXT: "high", CODEX_BROWSER: "none", QQ_CONTEXT_MAX_CHARS: "1800" }).toml);
    expect(ok).toMatchObject({ web_search: '"cached"', "tools.web_search.context_size": '"high"', "mcp_servers.qq_context.env.QQ_CONTEXT_MAX_CHARS": '"1800"' });
    expect(ok["[mcp_servers.browser]"]).toBeUndefined();

    const bad = runEntrypoint({ CODEX_WEB_SEARCH: 'live"\nx = 1', CODEX_WEB_SEARCH_CONTEXT: "huge", CODEX_BROWSER: "chrome", QQ_CONTEXT_MAX_CHARS: "1e9", PLAYWRIGHT_MCP_BIN: "/nonexistent/playwright-mcp" });
    const b = parse(bad.toml);
    expect(b).toMatchObject({ web_search: '"live"', "tools.web_search.context_size": '"low"', "mcp_servers.qq_context.env.QQ_CONTEXT_MAX_CHARS": '"2500"' });
    expect(b.x).toBeUndefined();
    expect(b["[mcp_servers.browser]"]).toBeUndefined(); // bin 不存在 → 不注册
    expect(bad.stderr).toContain("invalid value");
    expect(bad.stderr).toContain("browser MCP disabled");
  });
});
