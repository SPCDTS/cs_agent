import type { Channel } from "../../src/channel/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RecallTokens, startMediaRecallServer } from "../../src/context/media-recall-server.js";
import { chatsViaLoopback, recallViaLoopback } from "../../src/mcp/media-recall-client.js";
import { loadConfig } from "../../src/config.js";
import type { Access } from "../../src/context/access.js";

const access: Access = { kind: "scope", scope: "group:7" };
const closes: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closes.splice(0)) await close(); vi.useRealTimers(); });
async function setup(max = 5) {
  const recall = vi.fn(async () => ({ text: "图1: /data/media/ab/example.png（1×1）", images: [] }));
  const tokens = new RecallTokens({ recall }, max);
  const server = await startMediaRecallServer(tokens, 0);
  closes.push(server.close);
  const issue = (ticket = "ticket", deadline = Date.now() + 60_000) => tokens.issue({ access, ticket, deadline });
  const post = (token?: string, body: unknown = { message_id: "123" }) => fetch("http://127.0.0.1:" + server.port + "/recall", {
    method: "POST", headers: { ...(token ? { Authorization: "Bearer " + token } : {}), "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return { recall, tokens, server, issue, post };
}
describe("召回 loopback 与令牌", () => {
  it("仅绑定 127.0.0.1，无令牌/非法令牌拒绝", async () => {
    const s = await setup(); expect(s.server.host).toBe("127.0.0.1");
    expect((await s.post()).status).toBe(401);
    expect((await s.post("a".repeat(64))).status).toBe(401);
    expect(s.recall).not.toHaveBeenCalled();
  });
  it("范围来自令牌，不接受 access/scope 参数，客户端只返回路径文本", async () => {
    const s = await setup(), lease = s.issue();
    expect(lease.token).toMatch(/^[a-f0-9]{64}$/);
    expect((await s.post(lease.token, { message_id: "123", access: "all" })).status).toBe(400);
    expect((await s.post(lease.token, { message_id: "123", scope: "private:1" })).status).toBe(400);
    expect(await recallViaLoopback("123", lease.token, s.server.port)).toContain("/data/media/");
    expect(s.recall).toHaveBeenCalledWith(access, "123", expect.any(AbortSignal));
  });
  it("过期、撤销及外部取消立即拒绝", async () => {
    const s = await setup();
    const exp = s.issue("expiry", Date.now() + 20);
    await new Promise(r => setTimeout(r, 40));
    expect((await s.post(exp.token)).status).toBe(401);
    const revoked = s.issue(); revoked.revoke();
    expect((await s.post(revoked.token)).status).toBe(401);
    const control = new AbortController();
    const aborted = s.tokens.issue({ access, ticket: "abort", deadline: Date.now() + 60_000, signal: control.signal });
    control.abort();
    expect((await s.post(aborted.token)).status).toBe(401);
    expect(s.recall).not.toHaveBeenCalled();
  });
  it("额度同步扣减，并发最多五次；同票据新令牌不恢复额度", async () => {
    const s = await setup(), lease = s.issue();
    const results = await Promise.all(Array.from({ length: 7 }, () => s.post(lease.token)));
    expect(results.filter(r => r.status === 200)).toHaveLength(5);
    expect(results.filter(r => r.status === 429)).toHaveLength(2);
    expect(s.recall).toHaveBeenCalledTimes(5);
    lease.revoke();
    expect((await s.post(s.issue().token)).status).toBe(429);
    expect((await s.post(s.issue("another").token)).status).toBe(200);
    expect(() => s.tokens.issue({ access: { kind: "all" }, ticket: "ticket", deadline: Date.now() + 1000 })).toThrow("范围");
  });
  it("撤销中止在途召回；关闭端点作废所有令牌", async () => {
    const s = await setup(), lease = s.issue();
    let release!: () => void;
    s.recall.mockImplementation(async () => { await new Promise<void>(r => { release = r; }); return { text: "late", images: [] }; });
    const pending = s.post(lease.token);
    await vi.waitFor(() => expect(s.recall).toHaveBeenCalledOnce());
    const signal = (s.recall.mock.calls as unknown as [Access, string, AbortSignal][])[0]![2];
    lease.revoke(); expect(signal.aborted).toBe(true);
    expect((await pending).status).toBe(401); release();
    const second = s.issue("new");
    await s.server.close();
    expect(s.tokens.valid(second.token)).toBe(false);
  });
  it("配置有默认值并拒绝非法端口/预算", () => {
    expect(loadConfig({})).toMatchObject({ MEDIA_RECALL_PORT: 8790, MEDIA_RECALL_MAX_PER_TICKET: 5 });
    for (const value of ["0", "65536", "abc"]) expect(() => loadConfig({ MEDIA_RECALL_PORT: value })).toThrow();
    expect(() => loadConfig({ MEDIA_RECALL_MAX_PER_TICKET: "0" })).toThrow();
  });
  it("额度在最后一次作废后保留 30 分钟；活跃租约与重试不会重置预算", async () => {
    vi.useFakeTimers();
    const tokens = new RecallTokens({ recall: async () => ({ text: "ok", images: [] }) }, 1);
    const tickets = (tokens as unknown as { tickets: Map<string, unknown> }).tickets;
    const issue = () => tokens.issue({ access, ticket: "retained", deadline: Date.now() + 2 * 60 * 60_000 });
    try {
      const first = issue(), active = issue();
      await tokens.recall(first.token, "1"); first.revoke(); first.revoke();
      await vi.advanceTimersByTimeAsync(31 * 60_000);
      expect(tickets.size).toBe(1);
      await expect(tokens.recall(active.token, "1")).rejects.toThrow("次数");
      active.revoke();
      await vi.advanceTimersByTimeAsync(29 * 60_000);
      const retry = issue();
      await expect(tokens.recall(retry.token, "1")).rejects.toThrow("次数");
      await vi.advanceTimersByTimeAsync(2 * 60_000);
      expect(tickets.size).toBe(1); retry.revoke();
      await vi.advanceTimersByTimeAsync(30 * 60_000 - 1);
      expect(tickets.size).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(tickets.size).toBe(0);
      await expect(tokens.recall(issue().token, "1")).resolves.toMatchObject({ text: "ok" });
    } finally { tokens.close(); }
    expect(tickets.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });
  it("自动到期后的额度会回收，close 清理回收定时器", async () => {
    vi.useFakeTimers();
    const tokens = new RecallTokens({ recall: async () => ({ text: "ok", images: [] }) });
    const tickets = (tokens as unknown as { tickets: Map<string, unknown> }).tickets;
    tokens.issue({ access, ticket: "expiry", deadline: Date.now() + 1000 });
    await vi.advanceTimersByTimeAsync(1000 + 30 * 60_000);
    expect(tickets.size).toBe(0);
    tokens.issue({ access, ticket: "close", deadline: Date.now() + 1000 }).revoke();
    tokens.close();
    expect(tickets.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });
});


describe("会话列表 loopback", () => {
  async function chatsSetup() {
    const listChats = vi.fn<Channel["listChats"]>().mockResolvedValue({ groups: [{ group_id: "7", name: "家庭群" }], friends: [] });
    const tokens = new RecallTokens({ recall: async () => ({ text: "ok", images: [] }) }, 1, { listChats });
    const server = await startMediaRecallServer(tokens, 0); closes.push(server.close);
    const issue = (access: Access, ticket: string) => tokens.issue({ access, ticket, deadline: Date.now() + 60_000 });
    const post = (token?: string, body: unknown = {}) => fetch("http://127.0.0.1:" + server.port + "/chats", {
      method: "POST", headers: { ...(token ? { Authorization: "Bearer " + token } : {}), "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    return { listChats, tokens, server, issue, post };
  }
  it("缺失、伪造、过期令牌拒绝；scope 令牌无权访问，参数不能提升权限", async () => {
    const s = await chatsSetup();
    expect((await s.post()).status).toBe(401); expect((await s.post("a".repeat(64))).status).toBe(401);
    for (const scope of ["group:7", "private:1"]) {
      const lease = s.issue({ kind: "scope", scope }, scope);
      expect((await s.post(lease.token)).status).toBe(403);
      expect((await s.post(lease.token, { access: "all" })).status).toBe(400);
      lease.revoke(); expect((await s.post(lease.token)).status).toBe(401);
    }
    const exp = s.issue({ kind: "all" }, "expired");
    const now = Date.now(), clock = vi.spyOn(Date, "now").mockReturnValue(now + 61_000);
    try { expect((await s.post(exp.token)).status).toBe(401); } finally { clock.mockRestore(); }
    expect(s.listChats).not.toHaveBeenCalled();
  });
  it("all 返回清洗后的文本列表，不消耗媒体召回预算；拒绝非空参数", async () => {
    const s = await chatsSetup(), lease = s.issue({ kind: "all" }, "owner");
    for (const body of [{ scope: "group:7" }, [], null, { message_id: "1" }]) expect((await s.post(lease.token, body)).status).toBe(400);
    expect(s.listChats).not.toHaveBeenCalled();
    await s.tokens.recall(lease.token, "1");
    expect(await chatsViaLoopback(lease.token, s.server.port)).toBe("group:7 家庭群");
    expect((await s.post(lease.token)).status).toBe(200);
    expect(s.listChats).toHaveBeenCalledTimes(2);
  });
  it("撤销令牌立即取消在途查询，即使通道不响应取消也不能返回迟到结果", async () => {
    const s = await chatsSetup(), lease = s.issue({ kind: "all" }, "owner");
    let finish!: (v: Awaited<ReturnType<Channel["listChats"]>>) => void;
    s.listChats.mockImplementation(() => new Promise(r => { finish = r; }));
    const pending = s.post(lease.token);
    await vi.waitFor(() => expect(s.listChats).toHaveBeenCalledOnce());
    const signal = s.listChats.mock.calls[0]![0].signal;
    lease.revoke(); expect(signal.aborted).toBe(true);
    expect((await pending).status).toBe(401); finish({ groups: [], friends: [] });
  });
});
