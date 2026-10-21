import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { CodexRunner } from "../../src/agent/codex/runner.js";
import { RecallTokens, startMediaRecallServer } from "../../src/context/media-recall-server.js";
import { TURN_NOTICES } from "../../src/agent/replies.js";
import { FIXTURES } from "./helpers.js";
import { residentRig } from "./resident-fixture.js";

const servers: { close(): Promise<void> }[] = [];
afterEach(async () => { for (const s of servers.splice(0)) await s.close(); });

/**
 * codex 第 2 阶段适配层的端到端：ThreadHost → BackendRouter → CodexBackend → 真实 CodexRunner（假 codex 进程）
 * → im MCP 的 loopback /send（租约绑定会话与回合，身份在调用时从宿主求出）→ Outbox → QQ。
 */
async function codexRig(env: Record<string, string> = {}) {
  let runner!: CodexRunner;
  const r = await residentRig({ backend: "codex", codexAsk: (prompt, opts) => runner.ask(prompt, opts) });
  const tokens = new RecallTokens({ recall: async () => ({ text: "", images: [] }) }, 5, undefined, {
    permissions: async lease => r.grants.permissions(r.inbox.binding(lease.threadKey)),
    send: (lease, callKey, args, signal) => r.sendService.send({ ...r.inbox.binding(lease.threadKey), access: lease.access,
      workdir: lease.workdir! }, args, callKey, signal),
  });
  const server = await startMediaRecallServer(tokens, 0);
  servers.push(server);
  runner = new CodexRunner({
    command: [process.execPath, path.join(FIXTURES, "fake-codex.mjs")],
    codexHome: path.join(r.dir, "codex"), workspaceDir: path.join(r.dir, "ws"),
    threadsFile: path.join(r.dir, "codex-threads.json"), sandbox: "workspace-write", timeoutMs: 10_000,
    recallTokens: tokens, mediaRecallPort: server.port,
    env: { FAKE_CODEX_LOG: path.join(r.dir, "calls.jsonl"), ...env },
  });
  const calls = () => readFileSync(path.join(r.dir, "calls.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
  return { r, calls };
}

it("codex 回合经 loopback 发往本群，@ 本轮发送者，回合结束后输入 done", async () => {
  const { r, calls } = await codexRig({ FAKE_CODEX_SEND: "codex 回复" });
  const key = await r.say("5", "问 codex");
  await r.idle(20_000);
  expect(r.texts("7")).toEqual(["codex 回复"]);
  expect(r.mentions()).toEqual(["5"]);
  const rec = r.bridge.inbox.getInbound(key)!;
  expect(rec).toMatchObject({ state: "done" });
  expect(rec.turn_id).toMatch(/^codex:/);
  const [row] = r.bridge.outbox.listOutboxByTurn(rec.turn_id!);
  expect(row!.key).toBe(`group:7:${rec.turn_id}#1`);
  const start = calls().find(c => c.phase === "start")!;
  expect(String(start.stdin)).toContain("问 codex");
  expect((start.argv as string[]).some(a => a.includes("images") && a.includes("group_7"))).toBe(true);
  expect(calls().find(c => c.phase === "send")).toMatchObject({ status: 200 });
});

it("codex 不插话：同一发送者的第二条消息排到下一轮", async () => {
  const { r, calls } = await codexRig({ FAKE_CODEX_SLEEP_MS: "300" });
  await r.say("5", "第一条");
  await r.say("5", "第二条");
  await r.idle(20_000);
  const prompts = calls().filter(c => c.phase === "start").map(c => String(c.stdin));
  expect(prompts).toHaveLength(2);
  expect(prompts[0]).toContain("第一条");
  expect(prompts[1]).toContain("第二条");
});

it("codex 执行失败 = 回合失败，按 §8.1 发出错提示", async () => {
  const { r } = await codexRig({ FAKE_CODEX_EXIT_CODE: "1", FAKE_CODEX_NO_OUT: "1", FAKE_CODEX_NO_COMPLETED: "1" });
  await r.say("5", "会失败");
  await r.idle(20_000);
  expect(r.texts("7")).toEqual([TURN_NOTICES.failed]);
});

it("重启时进行中的 codex 回合按丢失结束并提示中断", async () => {
  const { r } = await codexRig({ FAKE_CODEX_SLEEP_MS: "5000" });
  await r.say("5", "很慢");
  await new Promise(resolve => setTimeout(resolve, 300));
  await r.host.idle();
  expect(r.host.thread("group:7")?.turnId).toMatch(/^codex:/);
  await r.restart();
  await r.idle(20_000);
  expect(r.texts("7")).toEqual([TURN_NOTICES.lost]);
});
