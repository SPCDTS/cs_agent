import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach } from "vitest";
import type { Channel } from "../../src/channel/types.js";
import { ReplyStore } from "../../src/qq/reply-store.js";

const stores: ReplyStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
const bound = new WeakSet<object>();

/** 旧任务测试的通道桩补上持久 Outbox；真实 bridge 行为另有集成测试。 */
export function withOutbox<T extends Pick<Channel, "getTicket" | "reply">>(bridge: T): T & Pick<Channel, "outbox" | "send" | "settleTicket"> {
  const b = bridge as T & Pick<Channel, "outbox" | "send" | "settleTicket">;
  if (bound.has(b)) return b;
  bound.add(b);
  const outbox = new ReplyStore(mkdtempSync(path.join(os.tmpdir(), "cs-outbox-stub-"))); stores.push(outbox);
  Object.assign(b, { outbox });
  const get = bridge.getTicket.bind(bridge), pending = new Set<string>();
  b.getTicket = async ticket => {
    const rec = await get(ticket);
    return rec ? Object.assign({ self_id: "2", message_type: "private", user_id: "1", group_id: null, source_message_id: "1",
      source_nickname: "测试", source_text: "", created_at: new Date().toISOString() }, rec,
      { status: pending.has(ticket) ? "pending" as const : rec.status }) : null;
  };
  b.send = async (key, _target, text, images, opts) => {
    const row = outbox.getOutbox(key)!;
    if (row.status === "sent") return { message_id: row.message_id!, already_sent: true, message_type: row.message_type, target_id: row.target_id };
    if (row.status !== "pending") throw new Error("uncertain");
    const result = await (b as Pick<Channel, "reply">).reply(row.ticket, text, images, opts);
    pending.add(row.ticket);
    outbox.markOutboxSending(key); outbox.markOutboxSent(key, result.message_id);
    return result;
  };
  b.settleTicket = async ticket => { pending.delete(ticket); };
  return b;
}
