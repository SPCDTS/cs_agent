import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, vi } from "vitest";
import { ReplyStore } from "../../src/qq/reply-store.js";
import { createQQBridge } from "../../src/qq/bridge.js";
import { SendService } from "../../src/agent/send-service.js";
import { ContextStore } from "../../src/context/store.js";
import { TRANSPARENT_PNG } from "../../src/media/gen/image-gen.js";
import type { InboundMessage } from "../../src/channel/types.js";
import { tmp } from "./helpers.js";

const clean: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of clean.splice(0).reverse()) await fn(); });
export function sendFixture(group = true) {
  const dir = tmp("cs-send-"), workdir = path.join(dir, "work");
  mkdirSync(workdir);
  writeFileSync(path.join(workdir, "image.png"), TRANSPARENT_PNG);
  writeFileSync(path.join(workdir, "file.txt"), "报告内容", "utf8");
  const store = new ReplyStore(dir), history = new ContextStore(dir);
  const msg: InboundMessage = { message_id: "11", message_type: group ? "group" : "private", group_id: group ? "7" : null,
    user_id: "1", self_id: "2", nickname: "问者", time: 1790000000, text: "你好", route_text: "你好", truncated: false,
    mentioned_self: group, images: [], segments: [] };
  const ticket = store.createTicket(msg);
  let n = 0;
  const call = vi.fn(async (action: string, _params?: Record<string, unknown>) => {
    if (action === "get_login_info") return { user_id: 2 };
    if (action.startsWith("upload_")) return { file_id: "file-" + ++n };
    return { message_id: String(++n) };
  });
  const bridge = createQQBridge({ httpUrl: "http://unused.test", wsUrl: "ws://unused.test", token: "",
    allowUsers: ["1"], allowGroups: ["7"], groupMentions: true, dataDir: dir, imageRoot: path.join(dir, "images") }, { client: { call } });
  const service = new SendService({ getChannel: () => bridge, dataDir: dir, store: history });
  clean.push(() => { store.close(); history.close(); }, () => bridge.stop());
  const binding = { ticket, workdir, source: { type: msg.message_type, user_id: msg.user_id, group_id: msg.group_id },
    access: { kind: "scope" as const, scope: group ? "group:7" : "private:1" } };
  return { dir, workdir, store, history, msg, ticket, bridge, service, binding, call };
}
