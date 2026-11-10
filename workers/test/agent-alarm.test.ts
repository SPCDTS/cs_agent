import { AsyncLocalStorage } from "node:async_hooks";
import { env, reset, runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { fauxProvider, fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { MODEL_PROVIDERS } from "../src/models";
import { ThreadDO } from "../src/thread";
import { MemoryExtractor } from "../src/memory/extractor";
import { input } from "./helpers";

afterEach(async () => { vi.restoreAllMocks(); await reset(); });

it("persists input before execution, keeps history passive, and runs tool continuations from the alarm", async () => {
  const origin = new AsyncLocalStorage<string>();
  const starts: (string | undefined)[] = [];
  const provider = fauxProvider({ models: [{ id: "test" }], tokensPerSecond: Infinity });
  const respond: FauxResponseFactory = () => {
    provider.setResponses([respond]);
    starts.push(origin.getStore());
    return starts.length === 1
      ? fauxAssistantMessage(fauxToolCall("qq_context", {}), { stopReason: "toolUse" })
      : fauxAssistantMessage("已完成上下文检索");
  };
  provider.setResponses([respond]);
  vi.spyOn(MODEL_PROVIDERS.faux, "create").mockReturnValue(provider.provider);
  const thread = env.THREAD.getByName("owner");
  const alarm = ThreadDO.prototype.alarm;
  const delivery = vi.spyOn(ThreadDO.prototype, "alarm").mockResolvedValue();
  const pending = thread.submit(input(601, "读取上下文", 10000001));
  await expect.poll(() => delivery.mock.calls.length).toBeGreaterThan(0);
  expect(await runInDurableObject(thread, (_instance, state) =>
    state.storage.sql.exec("SELECT status,when_busy FROM inbound").toArray())).toEqual([{ status: "queued", when_busy: null }]);
  await thread.sessionHistory("owner");
  expect(starts).toEqual([]);
  delivery.mockImplementation(function (this: ThreadDO) { return origin.run("alarm", () => alarm.call(this)); });
  await runInDurableObject(thread, (_instance, state) => state.storage.setAlarm(Date.now() + 60_000));
  await runDurableObjectAlarm(thread);
  expect(await pending).toEqual({ status: "done" });
  expect(starts).toEqual(["alarm", "alarm"]);
  expect(await thread.submit(input(601, "重复投递", 10000001))).toEqual({ deduped: true });
  await runDurableObjectAlarm(thread);
  expect(starts).toHaveLength(2);
  expect(await runInDurableObject(thread, (_instance, state) => state.storage.getAlarm())).toBeNull();
});

it("accepts another message while background memory extraction is waiting", async () => {
  const extracting = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  vi.spyOn(MemoryExtractor.prototype, "drain").mockImplementationOnce(async () => {
    extracting.resolve(); await release.promise;
  });
  const provider = fauxProvider({ models: [{ id: "test" }], tokensPerSecond: Infinity });
  provider.setResponses([fauxAssistantMessage("第一轮完成"), fauxAssistantMessage("第二轮完成")]);
  vi.spyOn(MODEL_PROVIDERS.faux, "create").mockReturnValue(provider.provider);
  const thread = env.THREAD.getByName("owner");
  try {
    expect(await thread.submit(input(602, "第一条", 10000001))).toEqual({ status: "done" });
    await extracting.promise;
    expect(await thread.submit(input(603, "第二条", 10000001))).toEqual({ status: "done" });
  } finally { release.resolve(); }
});
