import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createModels } from "@earendil-works/pi-ai/models";
import type { JsonObject } from "@earendil-works/pi-durable";
import { fauxProvider, fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { DurableObjectSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { threadWithBindings } from "./thread-fixture";
import { MemoryStore } from "../src/memory/store";
import * as models from "../src/models";
import { input } from "./helpers";

afterEach(async () => { vi.restoreAllMocks(); await reset(); });
function script(steps: { name: string; args: JsonObject }[]) {
  const faux = fauxProvider({ models: [{ id: "test" }], tokensPerSecond: Infinity });
  const outputs: string[] = [], offers: string[][] = [], sections: (string | null)[] = [];
  const captured = new Set<string>();
  const memorySections: number[] = [];
  const respond: FauxResponseFactory = transcript => {
    faux.setResponses([respond]);
    memorySections.push(transcript.messages.filter(message => message.role === "system" && message.sections?.memory !== undefined).length);
    for (const message of transcript.messages) if (message.role === "system") {
      if (message.toolsAdded) offers.push(message.toolsAdded.map(tool => tool.name));
      if (message.sections?.memory !== undefined) sections.push(message.sections.memory);
    }
    const last = transcript.messages.findLast(message => message.role === "toolResult");
    if (last?.role === "toolResult" && !captured.has(last.toolCallId)) {
      captured.add(last.toolCallId);
      outputs.push(last.content.filter(block => block.type === "text").map(block => block.text).join(""));
    }
    const next = steps.shift();
    return next ? fauxAssistantMessage(fauxToolCall(next.name, next.args), { stopReason: "toolUse" }) : fauxAssistantMessage("done");
  };
  faux.setResponses([respond]);
  vi.spyOn(models, "openModels").mockImplementation(() => {
    const registry = createModels(); registry.setProvider(faux.provider);
    return registry;
  });
  return { outputs, offers, sections, memorySections };
}

describe("memory tools in the real Harness", () => {
  it("executes all five tools with source attribution, deduplication, CAS feedback and next-request memory sections", async () => {
    const seen = script([
      { name: "mem_remember", args: { text: "喜欢烟雾弹。", kind: "fact", since: "2026-09-12" } },
      { name: "mem_remember", args: { text: "喜欢烟雾弹!", kind: "fact" } },
      { name: "mem_search", args: { query: "烟雾弹" } },
      { name: "mem_update", args: { id: 1, text: "喜欢闪光弹" } },
      { name: "mem_search", args: {} },
      { name: "mem_profile", args: { text: "偏好简洁回答", revision: "none" } },
      { name: "mem_profile", args: { text: "过期写入", revision: "none" } },
      { name: "mem_forget", args: { id: 1, reason: "测试删除" } },
    ]);
    const result = await runInDurableObject(env.THREAD.getByName("owner"), async (_instance, state) => {
      const instance = threadWithBindings(_instance, state, { ...env, MEMORY_EXTRACT_NAMESPACES: "" });
      expect(await instance.submit(input(1, "记住我的偏好", 10000001))).toEqual({ status: "done" });
      const store = new MemoryStore(new DurableObjectSqliteDatabase(state.storage), "owner");
      return { row: await store.get(1), versions: await store.db.all("SELECT * FROM memory_versions"), profile: await store.profile(),
        events: await store.db.all("SELECT * FROM events") };
    });
    expect(seen.outputs[0]).toContain("已记住：#1 [fact] (2026-09-12 起)");
    expect(seen.outputs[1]).toContain("未重复记录");
    expect(seen.outputs[2]).toContain("← 来源 私聊 10000001 #1");
    expect(seen.outputs[3]).toContain("已更新");
    expect(seen.outputs[4]).toContain("喜欢闪光弹");
    expect(seen.outputs[6]).toContain(`当前 revision=${result.profile.revision}`);
    expect(seen.outputs[6]).toContain("偏好简洁回答");
    expect(seen.outputs[7]).toContain("已遗忘");
    expect(result.row).toMatchObject({ status: "forgotten", author: "qq:10000001", source_message_id: "1", source_scope: "private:10000001", source_turn_id: expect.stringMatching(/^turn:/), recall_count: 1 });
    expect(result.versions).toHaveLength(3);
    expect(seen.offers[0]).toEqual(expect.arrayContaining(["mem_search", "mem_remember", "mem_update", "mem_forget", "mem_profile"]));
    expect(seen.sections.some(text => text?.includes("偏好简洁回答"))).toBe(true);
    expect(seen.memorySections.at(-1)).toBe(1);
    expect(JSON.stringify(result.events)).not.toContain("烟雾弹");
    expect(JSON.stringify(result.events)).not.toContain("偏好简洁回答");
  });

  it.each([
    { ns: "group:200000001", user: 10000004, group: 200000001 },
    { ns: "group:200000001", user: 10000001, group: 200000001 },
    { ns: "private:10000003", user: 10000003, group: undefined },
  ])("offers local memory writes in $ns and cannot read owner memories", async ({ ns, user, group }) => {
    const seen = script([{ name: "mem_search", args: { query: "专属" } }, { name: "mem_remember", args: { text: "越权写入", kind: "fact" } }]);
    await env.THREAD.getByName("owner").importMemory({ ns: "owner", memories: [{ id: 1, kind: "fact", text: "owner专属信息", author: "dashboard" }] });
    const result = await runInDurableObject(env.THREAD.getByName(ns), async (_instance, state) => {
      const instance = threadWithBindings(_instance, state, { ...env, MEMORY_EXTRACT_NAMESPACES: "" });
      await instance.submit(input(1, "查询专属", user, group, true));
      return instance.stats();
    });
    expect(seen.offers.flat().filter(name => name.startsWith("mem_"))).toEqual(expect.arrayContaining(["mem_search"]));
    expect(seen.offers.flat()).toContain("mem_profile");
    expect(seen.offers.flat()).toContain("mem_remember");
    expect(seen.outputs[0]).toContain("没有找到");
    expect(seen.outputs.join("\n")).not.toContain("owner专属信息");
    expect(seen.outputs[1]).toContain("已记住");
    expect(result.memory.active).toBe(1);
  });

  it("routes owner subject writes to the target and caps total writes at twenty per turn", async () => {
    const seen = script([{ name: "mem_remember", args: { text: "共享训练安排", kind: "fact", subject: "group:200000001" } },
      ...Array.from({ length: 21 }, (_, i) => ({ name: "mem_remember", args: { text: `条目${i}`, kind: "fact" } }))]);
    const stats = await runInDurableObject(env.THREAD.getByName("owner"), async (_instance, state) => {
      const instance = threadWithBindings(_instance, state, { ...env, MEMORY_EXTRACT_NAMESPACES: "" });
      await instance.submit(input(1, "多次写入", 10000001));
      return instance.stats();
    });
    expect(seen.outputs[0]).toContain("已记住");
    expect((await env.THREAD.getByName("group:200000001").memoryView("group:200000001", "")).memories.map(row => row.text)).toEqual(["共享训练安排"]);
    expect(seen.outputs.at(-1)).toContain("20 次");
    expect(stats.memory.active).toBe(19);
  });
});
