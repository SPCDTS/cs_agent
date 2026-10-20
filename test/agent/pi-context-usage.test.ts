import { afterEach, expect, it, vi } from "vitest";
import { AssistantEntry, type AgentEvent, type Conversation, type ConversationId, type EntryId, type EntryRecord, type Harness, type Storage } from "@earendil-works/pi-durable";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { ContextUsageStore } from "../../src/agent/context-usage.js";
import { PiContextObserver, piContextCapacity } from "../../src/agent/pi-context-usage.js";
import { tmp } from "./helpers.js";

const watch = vi.hoisted(() => vi.fn());
vi.mock("@earendil-works/pi-durable", async importOriginal => ({
  ...await importOriginal<typeof import("@earendil-works/pi-durable")>(), watchEvents: watch,
}));
afterEach(() => { vi.restoreAllMocks(); watch.mockReset(); });

it("pi 监听延迟时按已提交历史补齐请求，随后重复事件不重复记录且票据切换重置 seq", async () => {
  let listener!: (events: AgentEvent[]) => Promise<void>;
  watch.mockResolvedValue({ snapshot: { entries: [] },
    start: (fn: typeof listener) => { listener = fn; }, stop: async () => undefined });
  let ticket = "first";
  const harness = { snapshot: async () => ({ ticket }) } as unknown as Harness;
  const entry = (id: number): EntryRecord => ({
    id: id as EntryId, conversationId: 1 as ConversationId, kind: AssistantEntry.kind,
    model: [{ ...fauxAssistantMessage(`answer-${id}`), timestamp: id * 100,
      usage: { input: id * 1000, cacheRead: 500, cacheWrite: 50, output: 100, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }],
  }) as EntryRecord;
  const first = entry(1), last = entry(2);
  const entries = vi.fn().mockResolvedValueOnce({ items: [first], next: { page: 2 } })
    .mockResolvedValueOnce({ items: [last] });
  const conv = { id: 1, entries } as unknown as Conversation;
  const store = new ContextUsageStore(tmp("pi-observer-"));
  const observer = await PiContextObserver.open(harness, conv, "owner", store, {} as Storage, piContextCapacity(200000));
  const requests = vi.spyOn(store, "recordRequest"), turns = vi.spyOn(store, "recordTurn");
  try {
    expect(observer.lastRequest(ticket)).toBeUndefined();
    await observer.synchronize(ticket, 2 as EntryId);
    expect(entries).toHaveBeenCalledTimes(2);
    expect(requests.mock.calls.map(call => call[2])).toEqual([1, 2].map(seq => ({
      ticket: "first", seq, usedTokens: seq * 1000 + 550, cachedTokens: 500,
      outputTokens: 100, windowTokens: 200000, at: seq * 100,
    })));
    await listener([{ type: "message_end", entry: first }, { type: "entry_appended", entry: last }]);
    expect(requests).toHaveBeenCalledTimes(2);
    expect(turns).not.toHaveBeenCalled();
    expect(store.get("pi", "owner")?.turns).toBe(0);
    const copy = observer.lastRequest(ticket)!;
    copy.seq = 999;
    expect(observer.lastRequest(ticket)?.seq).toBe(2);
    ticket = "second";
    expect(observer.lastRequest(ticket)).toBeUndefined();
    observer.updateCapacity(piContextCapacity(400000));
    await listener([{ type: "message_end", entry: entry(3) }]);
    expect(requests.mock.calls[2][2]).toMatchObject({ ticket: "second", seq: 1, windowTokens: 400000 });
    expect(observer.lastRequest("first")).toBeUndefined();
  } finally { await observer.close(); await store.close(); }
});
