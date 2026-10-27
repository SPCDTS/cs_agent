import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { vi } from "vitest";
import type { EventInput, InboundRecord } from "../../../src/channel/types.js";
import type { OutboxRow } from "../../../src/channel/outbox.js";
import { EventsDoc } from "../../../src/agent/events/docs.js";
import { EventService } from "../../../src/agent/events/service.js";
import type { EventSource, EventSourceSettings, ExternalEvent } from "../../../src/agent/events/types.js";

export const ctx = BACKGROUND_CONTEXT;
export const START = Date.parse("2026-10-27T08:20:00Z");
export const mail = (id: string, extra: Partial<ExternalEvent> = {}): ExternalEvent => ({
  source: "gmail", externalId: id, occurredAt: START - 120_000, kind: "mail.received", title: "私密主题", summary: "私密摘要",
  actor: "私密发件人", ref: id, labels: ["INBOX"], ...extra,
});

export async function eventRig(source: EventSource = { id: "gmail" }, ownerBackend: () => Promise<string | undefined> = async () => "pi") {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cs-events-"));
  const records = new Map<string, InboundRecord>(), rows: OutboxRow[] = [];
  const event = vi.fn(), deliver = vi.fn(async (key: string) => { const record = records.get(key); if (record) record.state = "delivered"; });
  const insert = vi.fn((input: EventInput): InboundRecord => {
    const old = records.get(input.key); if (old) return old;
    const record: InboundRecord = { key: input.key, kind: "event", seq: records.size + 1, scope: "private:" + input.owner,
      thread_key: "owner", self_id: "", user_id: input.owner, group_id: null, message_type: "private", message_id: "",
      nickname: "", text: input.text, route_text: input.text, time: input.time, images: [], attachments: [],
      created_at: new Date().toISOString(), state: "queued", event_source: input.source, event_count: input.count, event_keys: input.eventKeys };
    for (const key of input.eventKeys) records.set(key, record);
    return record;
  });
  let harness: Harness, service: EventService;
  const open = async () => {
    harness = await Harness.open(await openNodeSqliteStorage(path.join(dir, "events.sqlite")), { registry: createRegistry(), models: createModels() }, ctx);
    service = new EventService({ harness, owner: "1", sources: [source], ownerBackend, now: Date.now, trace: { event }, outbox: () => rows,
      inbox: { get: key => records.get(key) ?? null, insert, deliver } });
    await service.start();
  };
  await open();
  return {
    get service() { return service; }, get harness() { return harness; }, records, event, insert, deliver, rows,
    async settings(settings: Partial<EventSourceSettings>) {
      await harness.commit(async tx => { Object.assign((await tx.doc(EventsDoc)).sources.gmail.settings, { intervalS: 3600 }, settings); }, ctx);
    },
    state: async () => (await service.list())[0]!,
    async restart() { await service.stop(); await harness.close(ctx); await open(); },
    async close() { await service.stop(); await harness.close(ctx); rmSync(dir, { recursive: true, force: true }); },
  };
}
