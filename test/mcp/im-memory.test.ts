import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryStore } from "../../src/context/memory/store.js";
import { ProfileStore } from "../../src/context/memory/profile.js";
import { MemoryService } from "../../src/agent/memory/service.js";
import { MEMORY_RULE, MEMORY_TOOLS } from "../../src/agent/memory/tools.js";
import type { CallBinding } from "../../src/context/media-recall-server.js";
import type { TurnIdentity } from "../../src/channel/types.js";
import { tmp } from "../agent/helpers.js";
import { imRig } from "./im-fixture.js";

const clean: (() => void)[] = [];
afterEach(() => { for (const fn of clean.splice(0)) fn(); });

/** codex 的 mem_* 经 im MCP → loopback（线程令牌）→ 主进程 MemoryService：每次调用按网关给出的本轮绑定复核。 */
async function setup() {
  const dir = tmp("cs-im-memory-");
  const store = new MemoryStore(dir);
  clean.push(() => store.close());
  const memory = new MemoryService({ store, profiles: new ProfileStore(dir), owners: ["1"] });
  const binding = (threadKey: string, identity: TurnIdentity): CallBinding => ({ threadKey, identity, inputs: [], turnId: "codex:t1",
    scope: threadKey === "owner" ? "private:1" : threadKey, access: threadKey === "owner" ? { kind: "all" } : { kind: "scope", scope: threadKey },
    workdir: path.join(dir, "ws"), session: "thr-1", imageDir: path.join(dir, "images") });
  const current = { binding: binding("owner", { kind: "user", sender: "1" }) };
  const rig = await imRig("owner", {
    resolve: () => current.binding,
    send: async () => ({}),
    memory: (b, name, args) => memory.tool({ ...b, backend: "codex" }, name, args),
  });
  const text = (result: Awaited<ReturnType<typeof rig.tool>>) => (result.content as { text: string }[]).map(c => c.text).join("\n");
  return { ...rig, store, current, binding, text };
}

describe("codex im MCP：mem_* 工具经 loopback 回主进程", () => {
  it("列出六个记忆工具，使用规则挂在 mem_remember 的说明里", async () => {
    const f = await setup();
    const tools = (await f.client.listTools()).tools;
    expect(tools.filter(t => t.name.startsWith("mem_")).map(t => t.name)).toEqual([...MEMORY_TOOLS]);
    expect(tools.find(t => t.name === "mem_remember")?.description).toContain(MEMORY_RULE);
    expect(tools.filter(t => t.description?.includes(MEMORY_RULE))).toHaveLength(1);
    expect(tools.find(t => t.name === "mem_search")?.annotations?.readOnlyHint).toBe(true);
  });

  it("owner 回合写入并检索；群成员回合读不到 owner 条目、不能改画像；没有确证身份的回合不能写", async () => {
    const f = await setup();
    const saved = await f.tool("mem_remember", { text: "喜欢简短的回复", kind: "preference", subject: "self" });
    expect(saved.isError).not.toBe(true);
    expect(f.text(saved)).toContain("已记住：#1 [preference] 喜欢简短的回复");
    expect(f.store.get(1)).toMatchObject({ ns: "owner", author: "qq:1", source_turn_id: "codex:t1" });
    expect(f.text(await f.tool("mem_search", { query: "简短" }))).toContain("#1 [preference]");
    expect(f.text(await f.tool("mem_profile", { text: "称呼：老王", revision: "none" }))).toContain("画像已保存");

    f.current.binding = f.binding("group:7", { kind: "user", sender: "5" });
    expect(f.text(await f.tool("mem_search", { query: "简短" }))).toBe("没有找到匹配的记忆。");
    const profile = await f.tool("mem_profile", { text: "群简介", revision: "none" });
    expect(profile.isError).toBe(true);
    expect(f.text(profile)).toContain("画像只能在 owner 本人的回合修改");
    expect((await f.post("mem_profile", { text: "群简介", revision: "none" })).status).toBe(400);
    expect((await f.tool("mem_forget", { id: 1, reason: "x" })).isError).toBe(true);

    f.current.binding = f.binding("group:7", { kind: "wake" });
    const denied = await f.tool("mem_remember", { text: "x", kind: "fact" });
    expect(denied.isError).toBe(true);
    expect(f.text(denied)).toContain("本轮身份未确证");
    expect(f.store.browse({ limit: 10 }).total).toBe(1);
  });

  it("令牌无效拒绝；参数错误作为工具错误返回", async () => {
    const f = await setup();
    expect((await f.post("mem_search", { query: "x" }, { callId: "exec-1" }, "0".repeat(64))).status).toBe(401);
    const bad = await f.tool("mem_search", { query: "" });
    expect(bad.isError).toBe(true);
    expect(f.text(bad)).toContain("参数无效");
  });
});
