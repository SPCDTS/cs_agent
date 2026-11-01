import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { Type } from "typebox";
import { parse } from "./protocol.ts";
import { atomicJson, exists, readJson, sha256 } from "./files.ts";

const ReceiptSchema = Type.Object({ version: Type.Literal(1), fingerprint: Type.String(), installedLock: Type.String() }, { additionalProperties: false });
async function optionalFile(file: string) { return await exists(file) ? await fs.readFile(file, "utf8") : ""; }
export async function ensureNpm(options: { cwd: string; args: string[]; fresh?: boolean; env?: NodeJS.ProcessEnv }): Promise<{ reused: boolean; code: number }> {
  const cwd = path.resolve(options.cwd), env = options.env ?? process.env;
  const allowed = /^(--(?:ignore-scripts|legacy-peer-deps|strict-peer-deps|install-links|prefer-offline|offline|foreground-scripts|no-bin-links)|--(?:omit|include)=(?:dev|optional|peer|prod)|--install-strategy=(?:hoisted|nested|shallow|linked))$/;
  if (options.args.some(value => !allowed.test(value))) throw new Error("unsupported_npm_option");
  const nodeDir = path.dirname(process.execPath);
  let npm: string | undefined;
  for (const candidate of [path.join(nodeDir, "node_modules/npm/bin/npm-cli.js"), path.resolve(nodeDir, "../lib/node_modules/npm/bin/npm-cli.js"), ...(env.npm_execpath ? [env.npm_execpath] : [])]) {
    if (await exists(candidate)) { npm = candidate; break; }
  }
  if (!npm) throw new Error("npm_cli_missing");
  const npmCli = npm;
  const run = (args: string[], quiet = false): Promise<{ code: number; output: string }> => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [npmCli, ...args], { cwd, env, windowsHide: true, stdio: ["ignore", quiet ? "pipe" : "inherit", quiet ? "pipe" : "inherit"] });
    let output = "";
    child.stdout?.setEncoding("utf8").on("data", chunk => { output = (output + chunk).slice(-65536); });
    child.stderr?.resume();
    child.once("error", reject); child.once("close", code => resolve({ code: code ?? 1, output: output.trim() }));
  });
  // 让 npm 自己解析 .npmrc、环境与命令行参数；忽略与依赖布局无关的临时环境值。
  const effective = await run(["config", "list", "--json", ...options.args], true);
  if (effective.code) return { reused: false, code: effective.code };
  const config: unknown = JSON.parse(effective.output);
  if (config === null || typeof config !== "object" || Array.isArray(config)) throw new Error("invalid_npm_configuration");
  const settings = Object.fromEntries(Object.entries(config).filter(([key]) => !["user-agent", "metrics-registry", "logs-dir", "cache"].includes(key)).sort(([a], [b]) => a.localeCompare(b)));
  const lock = await optionalFile(path.join(cwd, "npm-shrinkwrap.json")) || await fs.readFile(path.join(cwd, "package-lock.json"), "utf8");
  const fingerprint = sha256(JSON.stringify({ lock, manifest: await fs.readFile(path.join(cwd, "package.json"), "utf8"),
    node: process.version, abi: process.versions.modules, platform: process.platform, arch: process.arch,
    npm: (await run(["--version"], true)).output, args: options.args, settings }));
  const modules = path.join(cwd, "node_modules"), receiptFile = path.join(modules, ".cs-agent-npm.json");
  const installedLock = async () => sha256(await optionalFile(path.join(modules, ".package-lock.json")));
  if (!options.fresh && await exists(receiptFile)) {
    try {
      const receipt = parse(ReceiptSchema, await readJson(receiptFile));
      if (receipt.fingerprint === fingerprint && receipt.installedLock === await installedLock() && (await run(["ls", "--all", "--json", ...options.args], true)).code === 0) return { reused: true, code: 0 };
    } catch { /* 无效或不完整的收据按缓存未命中处理。 */ }
  }
  // 先撤销成功标记，进程中断或安装失败后不能复用半成品。
  await fs.rm(receiptFile, { force: true });
  const result = await run(["ci", "--no-audit", "--no-fund", ...options.args]);
  if (result.code === 0) await atomicJson(receiptFile, { version: 1, fingerprint, installedLock: await installedLock() });
  return { reused: false, code: result.code };
}
