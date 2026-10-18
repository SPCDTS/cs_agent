#!/usr/bin/env node
// Codex 0.163 实测：仅在一次性容器运行，禁止挂载真实 /data 或 /workspace。
// 先 npm run build，再将仓库只读挂到 /verify；使用 docker/seccomp-codex.json。
// docker run --rm --network none -e VERIFY_FAKE_DATA=1 --security-opt seccomp=./docker/seccomp-codex.json \
//   -v "$PWD:/verify:ro" --entrypoint node cs-agent:<tag> /verify/scripts/verify-codex-scopes.mjs
// 只运行沙箱与本地假 Responses 服务，不连接真实模型、不发送 QQ 消息。
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, symlinkSync, readdirSync, readFileSync } from "node:fs";
import { spawnSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { codexWorkspacePolicy } from "../dist/agent/codex-workspace.js";
import { CodexRunner } from "../dist/agent/codex-runner.js";

assert.equal(process.platform, "linux");
assert.equal(spawnSync("codex", ["--version"], { encoding: "utf8" }).stdout.trim(), "codex-cli 0.163.0");
assert.equal(process.env.VERIFY_FAKE_DATA, "1", "必须显式设置 VERIFY_FAKE_DATA=1，并只用一次性空数据容器");
for (const dir of ["/workspace/group_7", "/workspace/group_8", "/workspace/private_9", "/workspace/owner", "/data/prompts", "/data/workflows", "/data/codex/trace", "/etc/codex"]) mkdirSync(dir, { recursive: true });
writeFileSync("/workspace/group_7/own.txt", "OWN_SCOPE");
writeFileSync("/workspace/group_8/secret.txt", "OTHER_SCOPE");
writeFileSync("/data/secret.txt", "SYSTEM_SECRET");
writeFileSync("/data/codex/trace/other.json", "OTHER_SCOPE");
writeFileSync("/etc/codex/requirements.toml", '[permissions.filesystem]\ndeny_read=["/data/secret.txt"]\n');
writeFileSync("/data/codex/AGENTS.md", "GLOBAL_GUIDANCE");
// runner 每轮注入 IMAGE_REFS；给它一个禁用的合法 MCP 传输，避免连接任何生图服务。
writeFileSync("/data/codex/config.toml", '[sandbox_workspace_write]\nwritable_roots=["/workspace","/data/prompts","/data/workflows"]\nnetwork_access=true\n\n[mcp_servers.image_gen]\ncommand="node"\nargs=["--version"]\nenabled=false\n');
writeFileSync("/workspace/group_7/AGENTS.md", "LOCAL_GUIDANCE");
symlinkSync("/workspace/group_8", "/workspace/group_7/other");
const env = { ...process.env, CODEX_HOME: "/data/codex" };
const policy = key => codexWorkspacePolicy("/workspace", "/data", key, "workspace-write", false);
let checks = 0;
function check(name, fn) { fn(); checks++; console.log(`PASS ${name}`); }
const run = (key, command) => spawnSync("codex", ["sandbox", "--include-managed-config", "-P", "cs_agent_scope", "-C", policy(key).workspaceDir,
  ...policy(key).args, "--", "sh", "-c", command], { env, encoding: "utf8", timeout: 15000 });
check("本会话读写可用", () => { const r = run("group:7", "cat own.txt && touch writable"); assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout, "OWN_SCOPE"); });
for (const [name, command] of [
  ["跨群绝对路径", "cat /workspace/group_8/secret.txt"],
  ["跨群相对路径", "cat ../group_8/secret.txt"],
  ["跨群符号链接", "cat other/secret.txt"],
  ["复制跨群文件", "cp /workspace/group_8/secret.txt leaked"],
  ["创建跨群硬链接", "ln /workspace/group_8/secret.txt leaked"],
  ["修改全局提示词", "touch /data/prompts/forbidden"],
  ["修改全局工作流", "touch /data/workflows/forbidden"],
  ["覆盖系统 requirements", "touch /etc/codex/requirements.toml"],
  ["系统 deny_read 保留", "cat /data/secret.txt"],
  ["跨会话请求 trace", "cat /data/codex/trace/other.json"],
]) check(name + "被拒绝", () => { const r = run("group:7", command); assert.notEqual(r.status, 0); assert.doesNotMatch(r.stdout, /OTHER_SCOPE|SYSTEM_SECRET/); });
check("未来新建的会话同样隐藏", () => { mkdirSync("/workspace/private_10"); writeFileSync("/workspace/private_10/secret", "NEW_SECRET"); const r = run("group:7", "cat /workspace/private_10/secret"); assert.notEqual(r.status, 0); assert.doesNotMatch(r.stdout, /NEW_SECRET/); });
check("owner 可写提示词与工作流", () => { const r = run("owner", "touch /data/prompts/owner-ok /data/workflows/owner-ok"); assert.equal(r.status, 0, r.stderr); });
check("owner 也不能读取其他 workspace", () => assert.notEqual(run("owner", "cat /workspace/group_8/secret.txt").status, 0));
check("全局与 cwd AGENTS.md、每轮受管规则都进入实际提示词", () => {
  const r = spawnSync("codex", ["-C", policy("group:7").workspaceDir, "debug", "prompt-input", ...policy("group:7").args,
    "-c", 'developer_instructions="MANAGED_PER_TURN"', "test"], { env, encoding: "utf8", timeout: 15000 });
  assert.equal(r.status, 0, r.stderr);
  for (const marker of ["GLOBAL_GUIDANCE", "LOCAL_GUIDANCE", "MANAGED_PER_TURN"]) assert.ok(r.stdout.includes(marker));
});

// 用假 Responses 服务要求 Codex 调用内置 view_image，验证非 shell 文件工具同样受权限约束。
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
writeFileSync("/workspace/group_8/private.png", png);
let requests = 0, toolResult;
const inputs = [];
const server = createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  inputs.push(body.input);
  requests++;
  if (requests > 1) toolResult = body.input;
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const send = event => res.write(`data: ${JSON.stringify(event)}\n\n`);
  send({ type: "response.created", response: { id: `r${requests}`, object: "response", status: "in_progress", output: [] } });
  const item = requests === 1
    ? { type: "function_call", name: "view_image", call_id: "view_other", id: "fc1", arguments: JSON.stringify({ path: "/workspace/group_8/private.png" }) }
    : { type: "message", role: "assistant", id: "msg1", status: "completed", phase: "final_answer", content: [{ type: "output_text", text: "verified", annotations: [] }] };
  send({ type: "response.output_item.added", output_index: 0, item });
  send({ type: "response.output_item.done", output_index: 0, item });
  send({ type: "response.completed", response: { id: `r${requests}`, object: "response", status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
  res.end();
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
writeFileSync("/data/codex/config.toml", `model_provider="scope_test"\nmodel="gpt-5.4"\nweb_search="disabled"\n` +
  readFileSync("/data/codex/config.toml", "utf8") +
  `\n[model_providers.scope_test]\nname="scope_test"\nbase_url="http://127.0.0.1:${port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\n`);
try {
  const providerArgs = ["-c", 'model_provider="scope_test"',
    "-c", `model_providers.scope_test={name="scope_test",base_url="http://127.0.0.1:${port}/v1",wire_api="responses",requires_openai_auth=false}`,
    "-c", 'model="gpt-5.4"', "-c", 'web_search="disabled"'];
  const args = ["exec", "-C", "/workspace/group_7", "--skip-git-repo-check", "--json", ...policy("group:7").args,
    ...providerArgs, "test"];
  const child = spawn("codex", args, { env, detached: true });
  child.stdin.end();
  let stderr = ""; child.stderr.on("data", chunk => { stderr += chunk; }); child.stdout.resume();
  const timer = setTimeout(() => process.kill(-child.pid, "SIGKILL"), 45000);
  const code = await new Promise(resolve => child.on("close", resolve)); clearTimeout(timer);
  check("内置 view_image 拒绝跨会话图片", () => {
    assert.equal(code, 0, stderr);
    assert.ok(requests >= 2, stderr);
    const result = JSON.stringify(toolResult);
    assert.match(result, /denied|not allowed|permission|restricted|unable to locate image|No such file/i);
    assert.doesNotMatch(result, /data:image|input_image/);
  });
  const options = { command: ["codex"], codexHome: "/data/codex", workspaceDir: "/workspace",
    threadsFile: "/data/codex-threads.json", sandbox: "workspace-write", sandboxNetwork: false, timeoutMs: 45000 };
  const runner = new CodexRunner(options);
  await runner.ask("GROUP_A_ONLY_SENTINEL", { threadKey: "group:7" });
  const beforeB = inputs.length;
  await runner.ask("GROUP_B_ONLY_SENTINEL", { threadKey: "group:8" });
  const ids = await runner.readThreadIds();
  check("真实 Codex 回合产生独立线程及独立模型输入", () => {
    assert.ok(ids["group:7"]); assert.ok(ids["group:8"]); assert.notEqual(ids["group:7"], ids["group:8"]);
    assert.doesNotMatch(JSON.stringify(inputs.slice(beforeB)), /GROUP_A_ONLY_SENTINEL/);
    const files = readdirSync("/data/codex/sessions", { recursive: true }).filter(file => file.endsWith(`${ids["group:8"]}.jsonl`));
    assert.ok(files.length);
    for (const file of files) assert.doesNotMatch(readFileSync(`/data/codex/sessions/${file}`, "utf8"), /GROUP_A_ONLY_SENTINEL/);
  });
  const restarted = new CodexRunner(options);
  await restarted.ask("GROUP_B_RESUME_SENTINEL", { threadKey: "group:8" });
  check("重建 runner 后真实 resume 保持线程与 scope 权限", () => {
    const input = JSON.stringify(inputs.at(-1));
    assert.match(input, /GROUP_B_ONLY_SENTINEL/); assert.match(input, /GROUP_B_RESUME_SENTINEL/);
    assert.doesNotMatch(input, /GROUP_A_ONLY_SENTINEL/);
    assert.match(input, /workspace\/group_8/);
  });
  assert.deepEqual(await restarted.readThreadIds(), ids);
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
console.log(`${checks} checks passed`);
