import type { Channel } from "../../src/channel/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CALL_META_HEADER, parseCallMeta, ThreadTokens, startMediaRecallServer } from "../../src/context/media-recall-server.js";
import { callMetaOf, chatsViaLoopback, contextViaLoopback, recallViaLoopback } from "../../src/mcp/media-recall-client.js";
import { loadConfig } from "../../src/config.js";
import type { Access } from "../../src/context/access.js";
import { staticGateway } from "./gateway-fixture.js";

const access: Access = { kind: "scope", scope: "group:7" };
const closes: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closes.splice(0)) await close(); vi.useRealTimers(); });
async function setup(max = 5) {
  const recall = vi.fn(async () => ({ text: "图1: /data/media/ab/example.png（1×1）", images: [] }));
  const { gateway, resolve } = staticGateway(() => access);
  const tokens = new ThreadTokens({ recall }, gateway, max);
  const server = await startMediaRecallServer(tokens, 0);
  closes.push(server.close);
  const post = (token?: string, body: unknown = { message_id: "123" }, meta: unknown = { turnId: "t1" }) => fetch("http://127.0.0.1:" + server.port + "/recall", {
    method: "POST", headers: { ...(token ? { Authorization: "Bearer " + token } : {}), "Content-Type": "application/json", [CALL_META_HEADER]: JSON.stringify(meta) },
    body: JSON.stringify(body),
  });
  return { recall, resolve, tokens, server, post };
}
describe("线程令牌与 loopback", () => {
  it("仅绑定 127.0.0.1，无令牌/非法令牌拒绝", async () => {
    const s = await setup(); expect(s.server.host).toBe("127.0.0.1");
    expect((await s.post()).status).toBe(401);
    expect((await s.post("a".repeat(64))).status).toBe(401);
    expect(s.recall).not.toHaveBeenCalled();
  });

  it("范围由网关按令牌所属会话与调用元数据求出，不接受 access/scope 参数；客户端只返回路径文本", async () => {
    const s = await setup(), token = s.tokens.issue("group:7");
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect((await s.post(token, { message_id: "123", access: "all" })).status).toBe(400);
    expect((await s.post(token, { message_id: "123", scope: "private:1" })).status).toBe(400);
    expect(await recallViaLoopback("123", token, s.server.port, { callId: "exec-1", threadId: "thr-1" })).toContain("/data/media/");
    expect(s.resolve).toHaveBeenLastCalledWith("group:7", { callId: "exec-1", threadId: "thr-1" });
    expect(s.recall).toHaveBeenCalledWith(access, "123", expect.any(AbortSignal));
  });

  it("网关拒绝（调用不属于会话当前回合）与非法调用元数据返回错误，不执行召回", async () => {
    const s = await setup(), token = s.tokens.issue("group:7");
    s.resolve.mockRejectedValueOnce(new Error("本回合已结束，工具调用不再有效"));
    const denied = await s.post(token);
    expect(denied.status).toBe(400);
    expect(await denied.json()).toEqual({ error: "本回合已结束，工具调用不再有效" });
    expect((await s.post(token, { message_id: "1" }, { callId: "bad id with spaces" })).status).toBe(400);
    expect((await s.post(token, { message_id: "1" }, [])).status).toBe(400);
    expect(s.recall).not.toHaveBeenCalled();
  });

  it("同一会话重新签发即作废旧令牌；撤销会话与关闭端点作废所有令牌", async () => {
    const s = await setup();
    const old = s.tokens.issue("group:7"), fresh = s.tokens.issue("group:7"), other = s.tokens.issue("group:8");
    expect((await s.post(old)).status).toBe(401);
    expect((await s.post(fresh)).status).toBe(200);
    s.tokens.revoke("group:7");
    expect((await s.post(fresh)).status).toBe(401);
    expect(s.tokens.valid(other)).toBe(true);
    await s.server.close();
    expect(s.tokens.valid(other)).toBe(false);
  });

  it("额度按回合同步扣减，并发最多五次；新回合重新计数", async () => {
    const s = await setup(), token = s.tokens.issue("group:7");
    const results = await Promise.all(Array.from({ length: 7 }, () => s.post(token)));
    expect(results.filter(r => r.status === 200)).toHaveLength(5);
    expect(results.filter(r => r.status === 429)).toHaveLength(2);
    expect(s.recall).toHaveBeenCalledTimes(5);
    expect((await s.post(token, { message_id: "123" }, { turnId: "t2" })).status).toBe(200);
    expect(() => s.tokens.issue("")).toThrow("会话");
  });

  it("撤销中止在途召回", async () => {
    const s = await setup(), token = s.tokens.issue("group:7");
    let release!: () => void;
    s.recall.mockImplementation(async () => { await new Promise<void>(r => { release = r; }); return { text: "late", images: [] }; });
    const pending = s.post(token);
    await vi.waitFor(() => expect(s.recall).toHaveBeenCalledOnce());
    const signal = (s.recall.mock.calls as unknown as [Access, string, AbortSignal][])[0]![2];
    s.tokens.revoke("group:7"); expect(signal.aborted).toBe(true);
    expect((await pending).status).toBe(401); release();
  });

  it("/context 给出本次调用的范围、回合与线程；不接受参数", async () => {
    const recall = vi.fn();
    const { gateway } = staticGateway(() => ({ kind: "all" }));
    const tokens = new ThreadTokens({ recall }, gateway);
    const server = await startMediaRecallServer(tokens, 0); closes.push(server.close);
    const token = tokens.issue("owner");
    expect(await contextViaLoopback(token, server.port, { turnId: "t9" })).toEqual({ access: "all", turn_id: "codex:t9", session: "thread-1" });
    const bad = await fetch(`http://127.0.0.1:${server.port}/context`, { method: "POST", headers: { Authorization: "Bearer " + token }, body: '{"access":"all"}' });
    expect(bad.status).toBe(400);
  });

  it("配置有默认值并拒绝非法端口/预算", () => {
    expect(loadConfig({})).toMatchObject({ MEDIA_RECALL_PORT: 8790, MEDIA_RECALL_MAX_PER_TURN: 5 });
    for (const value of ["0", "65536", "abc"]) expect(() => loadConfig({ MEDIA_RECALL_PORT: value })).toThrow();
    expect(() => loadConfig({ MEDIA_RECALL_MAX_PER_TURN: "0" })).toThrow();
    // 改名前的变量名仍生效，现名优先；结果里不保留旧名
    expect(loadConfig({ MEDIA_RECALL_MAX_PER_TICKET: "7" })).toMatchObject({ MEDIA_RECALL_MAX_PER_TURN: 7 });
    expect(loadConfig({ MEDIA_RECALL_MAX_PER_TICKET: "7", MEDIA_RECALL_MAX_PER_TURN: "3" })).toMatchObject({ MEDIA_RECALL_MAX_PER_TURN: 3 });
    expect(() => loadConfig({ MEDIA_RECALL_MAX_PER_TICKET: "0" })).toThrow();
    expect(loadConfig({ OBS_TICKET_EVENT_CAP: "64" })).toMatchObject({ OBS_EVENT_CAP: 64 });
    expect(loadConfig({ OBS_TICKET_EVENT_CAP: "64" })).not.toHaveProperty("OBS_TICKET_EVENT_CAP");
  });
});

describe("调用元数据", () => {
  it("从 MCP _meta 取 callId 与 x-codex-turn-metadata（对象或 JSON 字符串），忽略非法字段", () => {
    expect(callMetaOf({ callId: "exec-1", "x-codex-turn-metadata": { session_id: "s", thread_id: "thr-1", turn_id: "turn-1" } }))
      .toEqual({ callId: "exec-1", threadId: "thr-1", turnId: "turn-1" });
    expect(callMetaOf({ callId: "exec-2", "x-codex-turn-metadata": JSON.stringify({ thread_id: "thr-2" }) })).toEqual({ callId: "exec-2", threadId: "thr-2" });
    expect(callMetaOf({ callId: "a b", "x-codex-turn-metadata": "{broken" })).toEqual({});
    expect(callMetaOf(undefined)).toEqual({});
    expect(parseCallMeta(undefined)).toEqual({});
    expect(() => parseCallMeta('{"callId":1}')).toThrow();
    expect(() => parseCallMeta("x".repeat(3000))).toThrow();
  });
});

describe("会话列表 loopback", () => {
  async function chatsSetup() {
    const listChats = vi.fn<Channel["listChats"]>().mockResolvedValue({ groups: [{ group_id: "7", name: "家庭群" }], friends: [] });
    const { gateway } = staticGateway(threadKey => threadKey === "owner" ? { kind: "all" } : { kind: "scope", scope: threadKey });
    const tokens = new ThreadTokens({ recall: async () => ({ text: "ok", images: [] }) }, gateway, 1, { listChats });
    const server = await startMediaRecallServer(tokens, 0); closes.push(server.close);
    const post = (token?: string, body: unknown = {}) => fetch("http://127.0.0.1:" + server.port + "/chats", {
      method: "POST", headers: { ...(token ? { Authorization: "Bearer " + token } : {}), "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    return { listChats, tokens, server, post };
  }
  it("缺失、伪造令牌拒绝；本会话范围无权访问，参数不能提升权限", async () => {
    const s = await chatsSetup();
    expect((await s.post()).status).toBe(401); expect((await s.post("a".repeat(64))).status).toBe(401);
    for (const scope of ["group:7", "private:1"]) {
      const token = s.tokens.issue(scope);
      expect((await s.post(token)).status).toBe(403);
      expect((await s.post(token, { access: "all" })).status).toBe(400);
      s.tokens.revoke(scope); expect((await s.post(token)).status).toBe(401);
    }
    expect(s.listChats).not.toHaveBeenCalled();
  });
  it("all 返回清洗后的文本列表，不消耗媒体召回预算；拒绝非空参数", async () => {
    const s = await chatsSetup(), token = s.tokens.issue("owner");
    for (const body of [{ scope: "group:7" }, [], null, { message_id: "1" }]) expect((await s.post(token, body)).status).toBe(400);
    expect(s.listChats).not.toHaveBeenCalled();
    await s.tokens.recall(token, {}, "1");
    expect(await chatsViaLoopback(token, s.server.port)).toBe("group:7 家庭群");
    expect((await s.post(token)).status).toBe(200);
    expect(s.listChats).toHaveBeenCalledTimes(2);
  });
  it("撤销令牌立即取消在途查询，即使通道不响应取消也不能返回迟到结果", async () => {
    const s = await chatsSetup(), token = s.tokens.issue("owner");
    let finish!: (v: Awaited<ReturnType<Channel["listChats"]>>) => void;
    s.listChats.mockImplementation(() => new Promise(r => { finish = r; }));
    const pending = s.post(token);
    await vi.waitFor(() => expect(s.listChats).toHaveBeenCalledOnce());
    const signal = s.listChats.mock.calls[0]![0].signal;
    s.tokens.revoke("owner"); expect(signal.aborted).toBe(true);
    expect((await pending).status).toBe(401); finish({ groups: [], friends: [] });
  });
});
