import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  const inheritedEnv = { ...process.env };
  for (const key of Object.keys(inheritedEnv)) {
    if (["CODEX_PROVIDER", "CODEX_MAGPIE_URL", "CODEX_MAGPIE_KEY"].includes(key.toUpperCase())) delete inheritedEnv[key];
  }
  delete inheritedEnv.CODEX_IMAGE_GEN;
  delete inheritedEnv.CODEX_REMOTE_PLUGINS;
  delete inheritedEnv.CODEX_PLUGIN_PRUNE;
  const r = spawnSync("sh", [posix(script), ...args], {
    env: {
      ...inheritedEnv, DATA_DIR: shPath(data), WORKSPACE_DIR: shPath(ws), WORKFLOWS_SRC: "/nonexistent",
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

/** 只在临时目录预置插件缓存和暂存目录，不接触真实 CODEX_HOME。 */
function seedPluginCache(names = ["figma", "gmail", "notion"]) {
  const dir = tmp("cs-entry-");
  const plugins = path.join(dir, "data", "codex", "plugins");
  const cache = path.join(plugins, "cache", "openai-curated-remote");
  const otherCache = path.join(plugins, "cache", "openai-bundled", "keep");
  const staging = path.join(plugins, ".remote-plugin-install-staging");
  for (const name of names) mkdirSync(path.join(cache, name, "x"), { recursive: true });
  mkdirSync(otherCache, { recursive: true });
  mkdirSync(path.join(staging, "pending"), { recursive: true });
  return { dir, cache, otherCache, staging };
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
      model_provider: '"magpie"',
      "model_providers.magpie.name": '"magpie"',
      "model_providers.magpie.base_url": '"http://host.docker.internal:3425/v1"',
      "model_providers.magpie.wire_api": '"responses"',
      "model_providers.magpie.env_key": '"CODEX_MAGPIE_KEY"',
      "model_providers.magpie.http_headers": '{ "x-openai-actor-authorization" = "cs-agent" }',
      "model_providers.magpie.supports_websockets": "false",
      "model_providers.magpie.model_catalog_url": '"http://host.docker.internal:3425/v1/codex/models"',
      model_reasoning_effort: '"high"',
      web_search: '"live"',
      "features.remote_plugin": "false",
      "features.plugins": "false",
      "tools.web_search.context_size": '"low"',
      "mcp_servers.qq_context.command": '"node"',
      "mcp_servers.qq_context.args": '["/app/dist/mcp/qq-context.js"]',
      "mcp_servers.qq_context.startup_timeout_sec": "10",
      "mcp_servers.qq_context.tool_timeout_sec": "15",
      "mcp_servers.qq_context.env.QQ_CONTEXT_MAX_CHARS": '"2500"',
      "mcp_servers.browser.env.PLAYWRIGHT_BROWSERS_PATH": '"/opt/pw-browsers"',
      // 非交互 codex exec（approval never）下 MCP 调用必须自动批准
      "mcp_servers.qq_context.default_tools_approval_mode": '"approve"',
      "mcp_servers.browser.default_tools_approval_mode": '"approve"',
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

  it("支持带前缀模型、自定义 URL 与尾斜杠，key 不写入文件或诊断", () => {
    const key = 'test-key-"\nshould-never-be-written';
    const r = runEntrypoint({ CODEX_MODEL: "codex/gpt-6.1-sol", CODEX_MAGPIE_URL: "https://gateway.example:3425/v1/", CODEX_MAGPIE_KEY: key });
    expect(r.status).toBe(0);
    expect(parse(r.toml)).toMatchObject({ model: '"codex/gpt-6.1-sol"', "model_providers.magpie.base_url": '"https://gateway.example:3425/v1"', "model_providers.magpie.model_catalog_url": '"https://gateway.example:3425/v1/codex/models"' });
    expect(r.toml + r.requirements + r.stdout + r.stderr).not.toContain(key);
    expect(r.toml).not.toContain("experimental_bearer_token");
  });

  it("openai 省略全部 magpie 配置，重启可移除旧提供者段", () => {
    const dir = tmp("cs-entry-");
    expect(runEntrypointIn(dir, {}).status).toBe(0);
    const r = runEntrypointIn(dir, { CODEX_PROVIDER: "openai", CODEX_MAGPIE_URL: 'ignored"url' });
    expect(r.status).toBe(0);
    expect(parse(r.toml).model_provider).toBeUndefined();
    expect(r.toml).not.toContain("[model_providers.magpie]");
    expect(r.toml).not.toContain("env_key =");
  });

  it.each(['http://host/"\nx=1', "http://user:secret@host/v1", "http://host/v1?key=x", "http://host/v1#x", "ftp://host/v1", "http://"])("非法 URL 不覆盖现有配置且不输出原值：%j", url => {
    const dir = tmp("cs-entry-");
    const before = runEntrypointIn(dir, {});
    const r = runEntrypointIn(dir, { CODEX_MAGPIE_URL: url });
    expect(r.status).not.toBe(0);
    expect(r.toml).toBe(before.toml);
    expect(r.stderr).toContain("ERROR");
    expect(r.stderr).not.toContain(url);
  });

  it("缺 key 仍可生成配置，鉴权由真正启动 codex 的 runner 校验", () => {
    const r = runEntrypoint({ CODEX_MAGPIE_KEY: "" });
    expect(r.status).toBe(0);
    expect(parse(r.toml)["model_providers.magpie.env_key"]).toBe('"CODEX_MAGPIE_KEY"');
    expect(runEntrypoint({ CODEX_PROVIDER: "unknown" }).status).not.toBe(0);
  });

  it("omits the remote plugin feature override when enabled", () => {
    const r = runEntrypoint({ CODEX_REMOTE_PLUGINS: "on" });
    expect(r.status).toBe(0);
    expect(parse(r.toml)["[features]"]).toBeUndefined();
    expect(parse(r.toml)["features.remote_plugin"]).toBeUndefined();
    expect(parse(r.toml)["features.plugins"]).toBeUndefined();
    expect(r.toml).not.toMatch(/^remote_plugin\s*=/m);
  });

  it.each(["off", "", "invalid", 'on"\nx = 1'])("defaults remote plugins to off for %j", (value) => {
    const r = runEntrypoint({ CODEX_REMOTE_PLUGINS: value });
    expect(r.status).toBe(0);
    expect(parse(r.toml)["features.remote_plugin"]).toBe("false");
    expect(parse(r.toml)["features.plugins"]).toBe("false");
    expect(parse(r.toml).x).toBeUndefined();
    if (value && value !== "off") {
      expect(r.stderr).toContain("entrypoint: WARNING invalid value");
      expect(r.stderr).toContain("CODEX_REMOTE_PLUGINS");
    }
  });

  it.each([undefined, "all", "", "figma,gmail"])("插件清理 %s 保留 skills/shared 与 .system", prune => {
    const { dir } = seedPluginCache();
    const files = ["shared/hello/SKILL.md", ".system/builtin/SKILL.md"].map(name => path.join(dir, "data", "codex", "skills", name));
    for (const file of files) { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, "保留技能", "utf8"); }
    const result = runEntrypointIn(dir, prune === undefined ? {} : { CODEX_PLUGIN_PRUNE: prune });
    expect(result.status, result.stderr).toBe(0);
    for (const file of files) expect(readFileSync(file, "utf8")).toBe("保留技能");
  });

  it("prunes figma and gmail by default on each startup while retaining notion", () => {
    const { dir, cache, otherCache, staging } = seedPluginCache();
    for (let startup = 0; startup < 2; startup++) {
      if (startup) mkdirSync(path.join(cache, "figma", "x"), { recursive: true });
      const r = runEntrypointIn(dir, {});
      expect(r.status).toBe(0);
      expect(existsSync(path.join(cache, "figma"))).toBe(false);
      expect(existsSync(path.join(cache, "gmail"))).toBe(false);
      expect(existsSync(path.join(cache, "notion", "x"))).toBe(true);
      expect(existsSync(otherCache)).toBe(true);
      expect(existsSync(staging)).toBe(false);
    }
  });

  it("removes the whole curated cache for all and tolerates missing directories", () => {
    const { dir, cache, otherCache, staging } = seedPluginCache();
    for (let startup = 0; startup < 2; startup++) {
      const r = runEntrypointIn(dir, { CODEX_PLUGIN_PRUNE: "all" });
      expect(r.status).toBe(0);
      expect(existsSync(cache)).toBe(false);
      expect(existsSync(otherCache)).toBe(true);
      expect(existsSync(staging)).toBe(false);
      expect(existsSync(path.join(dir, "data", "codex", "config.toml"))).toBe(true);
    }
  });

  it("keeps cached plugins for an empty prune list but clears install staging", () => {
    const { dir, cache, staging } = seedPluginCache();
    const r = runEntrypointIn(dir, { CODEX_PLUGIN_PRUNE: "" });
    expect(r.status).toBe(0);
    for (const name of ["figma", "gmail", "notion"]) expect(existsSync(path.join(cache, name, "x"))).toBe(true);
    expect(existsSync(staging)).toBe(false);
    expect(r.stderr).not.toContain("rejected CODEX_PLUGIN_PRUNE");
  });

  it("skips invalid prune entries without expanding globs or affecting valid entries", () => {
    const allowed = "Plugin_2.0-test";
    const { dir, cache, otherCache, staging } = seedPluginCache(["figma", "gmail", "notion", allowed]);
    const invalid = ["../notion", ".", "..", "*", "not?on", "[n]otion", "notion/", "notion\\x", "not ion", "插件", ""];
    const r = runEntrypointIn(dir, { CODEX_PLUGIN_PRUNE: ["figma", ...invalid, allowed, "gmail"].join(","), CODEX_REMOTE_PLUGINS: "on" });
    expect(r.status).toBe(0);
    for (const name of ["figma", "gmail", allowed]) expect(existsSync(path.join(cache, name))).toBe(false);
    expect(existsSync(path.join(cache, "notion", "x"))).toBe(true);
    expect(existsSync(otherCache)).toBe(true);
    expect(existsSync(staging)).toBe(false);
    for (const entry of invalid) expect(r.stderr).toContain("entrypoint: WARNING rejected CODEX_PLUGIN_PRUNE entry '" + entry + "'");
  });

  it("restricts the browser MCP to an enabled_tools allowlist without the RCE / local-file tools", () => {
    const binDir = tmp("cs-pwbin-");
    const bin = path.join(binDir, "playwright-mcp");
    writeFileSync(bin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const t = parse(runEntrypoint({ PLAYWRIGHT_MCP_BIN: posix(bin) }).toml);
    const enabled = JSON.parse(t["mcp_servers.browser.enabled_tools"]!) as string[];
    for (const must of ["browser_navigate", "browser_snapshot", "browser_click", "browser_type", "browser_evaluate", "browser_tabs", "browser_close"]) {
      expect(enabled).toContain(must);
    }
    for (const banned of ["browser_run_code_unsafe", "browser_run_code", "browser_file_upload", "browser_drop"]) expect(enabled).not.toContain(banned);
    expect(enabled.every((n) => /^browser_[a-z_]+$/.test(n))).toBe(true);
    // file: 不靠 --blocked-origins（无法表达）；阻止列表里不应出现无效的 file 模式
    const args = JSON.parse(t["mcp_servers.browser.args"]!) as string[];
    expect(args).not.toContain("--allow-unrestricted-file-access");
    expect(args[args.indexOf("--blocked-origins") + 1]).not.toMatch(/file:/);
  });

  it("writes [sandbox_workspace_write] with network and validated writable roots", () => {
    // 显式配置仍可开放 workflows；默认列表不再包含它。
    const def = parse(runEntrypoint({ CODEX_WRITABLE_ROOTS: "/workspace,/data/prompts,/data/workflows" }).toml);
    expect(def).toMatchObject({
      "sandbox_workspace_write.network_access": "true",
      "sandbox_workspace_write.writable_roots": '["/workspace", "/data/prompts", "/data/workflows"]',
    });
    // 默认值按实际 DATA_DIR / WORKSPACE_DIR 展开
    const d = runEntrypoint({});
    expect(parse(d.toml)["sandbox_workspace_write.writable_roots"]).toBe(
      `["${d.dataDir.replace(/data$/, "ws")}", "${d.dataDir}/prompts", "${d.dataDir}/codex/skills/shared"]`,
    );
    // 拒绝：相对路径、/、DATA_DIR 本身、CODEX_HOME 及其子目录、图片目录、*.sqlite、.. 与非法字符
    const dir = tmp("cs-entry-");
    const data = shPath(path.join(dir, "data"));
    const roots = ["/workspace", " /srv/prompts/ ", "relative", "/", data, `${data}/`, `${data}/codex`, `${data}/codex/sessions`,
      `${data}/codex/skills`, `${data}/codex/skills/shared-other`, `${data}/codex/skills/shared/nested`, `${data}/codex/skills/shared`,
      `${data}/files`, `${data}/files/x`, `${data}/images`, `${data}/incoming`, `${data}/incoming/x`, `${data}/tickets`, `${data}/tickets/x`, `${data}/qq-messages.sqlite`, "/x/../etc", '/w"x', "/opt/ok"];
    const r = runEntrypointIn(dir, { CODEX_SANDBOX_NETWORK: "false", CODEX_WRITABLE_ROOTS: roots.join(",") });
    const t = parse(r.toml);
    expect(t["sandbox_workspace_write.network_access"]).toBe("false");
    expect(t["sandbox_workspace_write.writable_roots"]).toBe(`["/workspace", "/srv/prompts", "${data}/codex/skills/shared", "/opt/ok"]`);
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
      `${d}/codex/auth.json`, `${d}/codex/sessions`, `${d}/codex/*.sqlite*`, `${d}/codex/history.jsonl`, `${d}/codex/trace`,
      `${d}/*.sqlite*`, `${d}/files`, `${d}/images`, `${d}/media`, `${d}/incoming`, `${d}/tickets`, `${d}/codex-session.json*`, `${d}/codex-threads.json`,
    ]));
    // 不能整个禁读 CODEX_HOME（codex 的 arg0 辅助程序在 $CODEX_HOME/tmp）；config.toml / AGENTS.md 可读
    expect(list).not.toContain(`${d}/codex`);
    expect(list).not.toContain(`${d}/codex-threads-archive.jsonl`);
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
    writeFileSync(path.join(data, "workflows", "wf.json"), "edited by operator");
    writeFileSync(path.join(src, "wf.json"), "{\"v\":2}");
    runEntrypointIn(dir, env);
    expect(readFileSync(path.join(data, "workflows", "wf.json"), "utf8")).toBe("edited by operator");
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

  it("makes the MCP approval mode configurable and validated", () => {
    const binDir = tmp("cs-pwbin-");
    const bin = path.join(binDir, "playwright-mcp");
    writeFileSync(bin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const ok = parse(runEntrypoint({ PLAYWRIGHT_MCP_BIN: posix(bin), CODEX_MCP_APPROVAL_MODE: "auto" }).toml);
    expect(ok["mcp_servers.qq_context.default_tools_approval_mode"]).toBe('"auto"');
    expect(ok["mcp_servers.browser.default_tools_approval_mode"]).toBe('"auto"');
    const bad = runEntrypoint({ PLAYWRIGHT_MCP_BIN: posix(bin), CODEX_MCP_APPROVAL_MODE: "never" });
    const b = parse(bad.toml);
    expect(b["mcp_servers.qq_context.default_tools_approval_mode"]).toBe('"approve"');
    expect(b["mcp_servers.browser.default_tools_approval_mode"]).toBe('"approve"');
    expect(bad.stderr).toContain("invalid value 'never' for CODEX_MCP_APPROVAL_MODE");
  });

  it.each([undefined, "off", "", "invalid", 'on"\nx = 1'])("默认或无效开关不注册 image_gen：%j", value => {
    const r = runEntrypoint(value === undefined ? {} : { CODEX_IMAGE_GEN: value });
    expect(r.status).toBe(0);
    expect(parse(r.toml)["[mcp_servers.image_gen]"]).toBeUndefined();
    expect(parse(r.toml)["[mcp_servers.image_gen.env]"]).toBeUndefined();
  });

  it("透传附件限制与工作区根到 qq_context", () => {
    const r = runEntrypoint({ ATTACH_FILE_MAX_MB: "5", ATTACH_FILES_MAX: "2", ATTACH_FILE_DENY_EXT: ".zip,.exe" });
    expect(r.status).toBe(0);
    expect(parse(r.toml)).toMatchObject({ "mcp_servers.qq_context.env.ATTACH_FILE_MAX_MB": '"5"', "mcp_servers.qq_context.env.ATTACH_FILES_MAX": '"2"', "mcp_servers.qq_context.env.ATTACH_FILE_DENY_EXT": '".zip,.exe"', "mcp_servers.qq_context.env.WORKSPACE_DIR": `"${r.dataDir.replace(/data$/, "ws")}"` });
  });

  it("writes the image_gen MCP section with COMFY_* passthrough, timeout and approval mode", () => {
    const r = runEntrypoint({
      CODEX_IMAGE_GEN: "on", COMFY_QWEN_CACHE: "true", COMFY_MODE: "mcp", COMFYUI_URL: "http://host.docker.internal:8188", COMFY_TIMEOUT_SEC: "240", IMAGE_GEN_MCP_WAIT_SEC: "45",
      COMFY_WORKFLOW_FILE: "/data/workflows/qwen-image-2.1-turbo-api.json", COMFY_PROMPT_NODE: "4",
      COMFY_MCP_BIN: "/opt/comfy/bin/comfy-mcp", COMFY_CHECKPOINT: 'bad"value', CODEX_MCP_APPROVAL_MODE: "auto",
    });
    expect(r.status).toBe(0);
    const t = parse(r.toml);
    expect(t).toMatchObject({
      "[mcp_servers.image_gen]": "",
      "mcp_servers.image_gen.command": '"node"',
      "mcp_servers.image_gen.args": '["/app/dist/mcp/image-gen.js"]',
      "mcp_servers.image_gen.startup_timeout_sec": "10",
      "mcp_servers.image_gen.tool_timeout_sec": "270",
      "mcp_servers.image_gen.default_tools_approval_mode": '"auto"',
      "mcp_servers.image_gen.env.DATA_DIR": `"${r.dataDir}"`,
      "mcp_servers.image_gen.env.COMFY_QWEN_CACHE": '"true"',
      "mcp_servers.image_gen.env.COMFY_MODE": '"mcp"',
      "mcp_servers.image_gen.env.COMFYUI_URL": '"http://host.docker.internal:8188"',
      "mcp_servers.image_gen.env.COMFY_TIMEOUT_SEC": '"240"',
      "mcp_servers.image_gen.env.IMAGE_GEN_MCP_WAIT_SEC": '"45"',
      "mcp_servers.image_gen.env.COMFY_WORKFLOW_FILE": '"/data/workflows/qwen-image-2.1-turbo-api.json"',
      "mcp_servers.image_gen.env.COMFY_PROMPT_NODE": '"4"',
      "mcp_servers.image_gen.env.COMFY_MCP_BIN": '"/opt/comfy/bin/comfy-mcp"',
    });
    // IMAGE_TICKET_DIR 每轮以 -c 注入，不写进受管文件；带引号的值不写入 TOML
    expect(r.toml).not.toMatch(/^IMAGE_TICKET_DIR/m);
    expect(r.toml).not.toMatch(/^IMAGE_REFS/m);
    expect(t["mcp_servers.image_gen.env.COMFY_CHECKPOINT"]).toBeUndefined();
    expect(r.stderr).toContain("COMFY_CHECKPOINT contains quotes or backslashes");
  });

  it("image_gen tool timeout falls back to 300+30 for a non-numeric COMFY_TIMEOUT_SEC", () => {
    const t = parse(runEntrypoint({ CODEX_IMAGE_GEN: "on", COMFY_TIMEOUT_SEC: "abc" }).toml);
    expect(t["mcp_servers.image_gen.tool_timeout_sec"]).toBe("330");
  });
});
