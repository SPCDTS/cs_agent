import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { WsbBackend, command, descriptor, protectToken, type Config } from "../src/wsb.ts";
import { readJson, sha256 } from "../src/files.ts";
import { parse, ExecResultSchema, type JobInput, type Lease } from "../src/protocol.ts";
if (process.platform !== "win32") throw new Error("Windows only");
const state = await fs.mkdtemp(path.join(os.tmpdir(), "cs-agent-wsb-smoke-"));
const gitExecutable = (await command("where.exe", ["git.exe"])).trim().split(/\r?\n/)[0];
if (!gitExecutable) throw new Error("git_required");
const config: Config = { origin: "http://localhost:8787", deviceId: randomUUID(), tokenProtected: "unused", name: "wsb-smoke",
  nodeDir: path.dirname(process.execPath), gitDir: process.env.CS_AGENT_GIT_DIR ?? path.dirname(path.dirname(gitExecutable)), memoryMiB: 4096, maxTimeoutMs: 1200000, dataDir: state + "-data" };
const backend = new WsbBackend(state, config, fileURLToPath(new URL("../dist/", import.meta.url)));
const capabilities = await descriptor(config);
assert.equal(await protectToken(await protectToken("test-token"), true), "test-token");
let binding: Lease = { id: randomUUID(), deviceId: config.deviceId, sandboxId: "remote:" + config.deviceId, workspace: "smoke", operationId: randomUUID(),
  capabilityRevision: sha256(JSON.stringify(capabilities)), requirements: { tools: ["powershell"] }, createdAt: Date.now() };
function prepare(command: string): JobInput { return { id: randomUUID(), lease: binding, tool: "powershell", arguments: { command },
  timeoutMs: 120000, createdAt: Date.now(), deadline: Date.now() + 420000 }; }
const js = (source: string) => '& node.exe -e "eval(Buffer.from(\'' + Buffer.from(source).toString("base64") + "','base64').toString())\"; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; ";
const setup = "New-Item repo -ItemType Directory | Out-Null; Set-Location repo; " + js("const fs=require('node:fs'); fs.mkdirSync('fixture',{recursive:true}); fs.writeFileSync('fixture/package.json',JSON.stringify({name:'sandbox-smoke-dep',version:'1.0.0',main:'index.cjs'})); fs.writeFileSync('fixture/index.cjs',\"module.exports='依赖已安装'\"); fs.writeFileSync('package.json',JSON.stringify({name:'wsb-smoke',version:'1.0.0',scripts:{test:'node --test sample.test.cjs'},dependencies:{'sandbox-smoke-dep':'file:./sandbox-smoke-dep-1.0.0.tgz'}})); fs.writeFileSync('sample.test.cjs',\"const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'); test('沙箱测试',()=>{assert.equal(require('sandbox-smoke-dep'),'依赖已安装');fs.writeFileSync('中文.txt','你好，远程沙箱');fs.writeFileSync('binary.bin',Buffer.from([0,255,1]));console.log('中文 stdout');console.error('中文 stderr');});\");") +
  "& git.exe init; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; & npm.cmd pack ./fixture --offline --ignore-scripts; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; & npm.cmd install --package-lock-only --ignore-scripts --no-audit --no-fund; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; & node.exe C:\\AgentTools\\runner\\npm-ensure.mjs --offline; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; & npm.cmd test; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; " +
  js("const fs=require('node:fs');fs.writeFileSync('.gitignore','node_modules/\\n');fs.writeFileSync('seed.txt','committed');") +
  "& git.exe add .; & git.exe -c user.name=Smoke -c user.email=smoke@example.invalid commit -m fixture; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; " +
  js("const fs=require('node:fs');fs.writeFileSync('seed.txt','parent-dirty');fs.writeFileSync('C:/AgentCache/npm/shared-probe.txt','shared');");
const verify = "Set-Location C:\\AgentWork\\repo; " + js("const fs=require('node:fs'),assert=require('node:assert/strict');assert.ok(fs.existsSync('.git'));assert.ok(fs.existsSync('node_modules/sandbox-smoke-dep'));assert.equal(require('sandbox-smoke-dep'),'依赖已安装');assert.equal(fs.readFileSync('中文.txt','utf8'),'你好，远程沙箱');assert.deepEqual(fs.readFileSync('binary.bin'),Buffer.from([0,255,1]));console.log('会话文件、git 与 node_modules 均保留');") + "& git.exe status --short";
console.log(JSON.stringify({ state }));
try {
  const first = await backend.run(prepare(setup), new AbortController().signal, message => process.stdout.write(message));
  if (first.kind !== "completed") throw new Error(JSON.stringify(first));
  const firstResult = parse(ExecResultSchema, first.result);
  assert.equal(firstResult.code, 0, firstResult.stdout + firstResult.stderr); assert.match(firstResult.stdout, /中文 stdout/); assert.match(firstResult.stdout + firstResult.stderr, /中文 stderr/);
  const instance = await readJson(path.join(state, "instance.json"));
  const second = await backend.run(prepare(verify), new AbortController().signal, message => process.stdout.write(message));
  if (second.kind !== "completed") throw new Error(JSON.stringify(second));
  const secondResult = parse(ExecResultSchema, second.result);
  assert.equal(secondResult.code, 0, secondResult.stdout + secondResult.stderr); assert.match(secondResult.stdout, /均保留/);
  assert.deepEqual(await readJson(path.join(state, "instance.json")), instance);
  await backend.release(binding.id);
  binding = { ...binding, id: randomUUID(), operationId: randomUUID(), createdAt: Date.now() };
  const resumed = await backend.run(prepare(verify + "; & node.exe C:\\AgentTools\\runner\\npm-ensure.mjs --offline"), new AbortController().signal, message => process.stdout.write(message));
  if (resumed.kind !== "completed") throw new Error(JSON.stringify(resumed));
  const resumedResult = parse(ExecResultSchema, resumed.result);
  assert.equal(resumedResult.code, 0, resumedResult.stdout + resumedResult.stderr); assert.match(resumedResult.stdout, /复用 node_modules/);
  assert.notDeepEqual(await readJson(path.join(state, "instance.json")), instance);
  await backend.release(binding.id);
  binding = { ...binding, id: randomUUID(), operationId: randomUUID(), workspace: "smoke-child", workspaceSource: { workspace: "smoke" }, createdAt: Date.now() };
  const childCommand = js("const fs=require('node:fs'),assert=require('node:assert/strict');assert.equal(fs.existsSync('repo/node_modules'),false);assert.equal(fs.readFileSync('repo/seed.txt','utf8'),'committed');assert.equal(fs.readFileSync('C:/AgentCache/npm/shared-probe.txt','utf8'),'shared');assert.equal(fs.existsSync('repo/.git/objects/info/alternates'),false);let denied=false;try{fs.writeFileSync('C:/AgentSeed/repo/seed.txt','forbidden');}catch{denied=true;}assert.ok(denied);console.log('来源只读与缓存共享验证通过');") +
    "Set-Location repo; & node.exe C:\\AgentTools\\runner\\npm-ensure.mjs --offline; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; & npm.cmd test; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; " +
    js("const fs=require('node:fs'),assert=require('node:assert/strict'),cp=require('node:child_process');assert.match(cp.execFileSync('git.exe',['branch','--show-current'],{encoding:'utf8'}),/^agent\\//);fs.writeFileSync('seed.txt','child-dirty');") + verify;
  const child = await backend.run(prepare(childCommand), new AbortController().signal, message => process.stdout.write(message));
  if (child.kind !== "completed") throw new Error(JSON.stringify(child));
  const childResult = parse(ExecResultSchema, child.result);
  assert.equal(childResult.code, 0, childResult.stdout + childResult.stderr); assert.match(childResult.stdout, /已准备独立仓库/); assert.match(childResult.stdout, /来源只读与缓存共享验证通过/);
  await backend.release(binding.id);
  binding = { ...binding, id: randomUUID(), operationId: randomUUID(), workspace: "smoke", createdAt: Date.now() }; delete binding.workspaceSource;
  const parent = await backend.run(prepare(verify + "; " + js("const fs=require('node:fs'),assert=require('node:assert/strict');assert.equal(fs.readFileSync('seed.txt','utf8'),'parent-dirty');")), new AbortController().signal, message => process.stdout.write(message));
  if (parent.kind !== "completed") throw new Error(JSON.stringify(parent));
  const parentResult = parse(ExecResultSchema, parent.result);
  assert.equal(parentResult.code, 0, parentResult.stdout + parentResult.stderr);
  const abort = new AbortController();
  const cancelled = await backend.run(prepare("Start-Sleep -Seconds 120"), abort.signal, message => { process.stdout.write(message); if (message.includes("正在执行")) setTimeout(() => abort.abort(), 1500); });
  assert.equal(cancelled.kind, "cancelled"); assert.equal(cancelled.sessionLost, true);
  assert.deepEqual(await backend.run(prepare("Get-Location"), new AbortController().signal, () => undefined), { kind: "failed", error: "session_lost", sessionLost: true });
  await backend.release(binding.id);
  assert.equal(await fs.readFile(path.join(config.dataDir!, "projects", sha256(binding.workspace), "repo", "中文.txt"), "utf8"), "你好，远程沙箱");
  console.log("WSB 内 npm 安装与依赖复用、同实例命令、新租约与新 VM 恢复中文/二进制/git/node_modules、取消后持久文件保留，以及子工作区独立 clone、只读来源、离线安装和 npm 缓存共享均通过。");
} finally { await backend.stopOwned(); }
