import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
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
    permissions: async lease => r.grants.permissions(r.inbox.bindingForTurn(lease.threadKey, lease.turnId)),
    send: (lease, callKey, args, signal) => r.sendService.send({ ...r.inbox.bindingForTurn(lease.threadKey, lease.turnId), access: lease.access,
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

it("codex 回合被唤醒回合取代：旧 exec 被中止，其租约不能以下一轮（owner）的身份发送", async () => {
  const { r, calls } = await codexRig({ FAKE_CODEX_SLEEP_MS: "2000", FAKE_CODEX_SEND: "回复" });
  const first = await r.say("5", "普通用户的问题");
  await vi.waitFor(() => expect(r.host.thread("group:7")?.turnId).toMatch(/^codex:/), { timeout: 5000 });
  const oldTurn = r.host.thread("group:7")!.turnId!;
  // 后端开的唤醒回合取代了进行中的 codex 回合（宿主没收到上一轮的结束事件）
  r.host.onTurnStarted("group:7", "pi:999:999", "backend");
  await r.host.idle();
  r.host.onTurnCompleted("group:7", "pi:999:999", { status: "completed" });
  await r.host.idle();
  await r.say("1", "owner 的问题");
  await vi.waitFor(() => expect(r.host.thread("group:7")?.turnSender).toBe("1"), { timeout: 5000 });
  const ownerTurn = r.host.thread("group:7")!.turnId!;
  expect(() => r.inbox.bindingForTurn("group:7", oldTurn)).toThrow("本回合已结束");
  expect(r.inbox.bindingForTurn("group:7", ownerTurn).identity).toEqual({ kind: "user", sender: "1" });
  await r.idle(20_000);
  expect(r.bridge.inbox.getInbound(first)!.turn_id).toBe(oldTurn);
  expect(r.bridge.outbox.listOutboxByTurn(oldTurn)).toEqual([]);
  expect(r.bridge.outbox.listOutboxByTurn(ownerTurn)).toMatchObject([{ status: "sent", mention_user_id: "1" }]);
  expect(r.texts("7")).toEqual(["回复"]);
  expect(calls().filter(c => c.phase === "send")).toHaveLength(1);
});
