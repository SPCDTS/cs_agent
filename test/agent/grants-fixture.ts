import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { defineExtension, MemoryStorage } from "@earendil-works/pi-durable";
import { afterEach, vi } from "vitest";
import { GrantsService } from "../../src/agent/grants.js";
import { openHarness } from "../../src/agent/harness.js";
import { SendService } from "../../src/agent/send-service.js";
import { DEFAULT_SEND_RULES, type SendRuleLimits } from "../../src/channel/send-rules.js";
import type { InboundMessage } from "../../src/channel/types.js";
import { ContextStore } from "../../src/context/store.js";
import { TRANSPARENT_PNG } from "./helpers.js";
import { createQQBridge } from "../../src/qq/bridge.js";
import { ReplyStore } from "../../src/qq/reply-store.js";
import { tmp } from "./helpers.js";

const clean: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of clean.splice(0).reverse()) await fn(); });

/** 真实 bridge（假 OneBot）与消息库；群 7 中 QQ 1 的一条输入已在 Inbox。 */
export function bridgeFixture(owners?: readonly string[]) {
  const dir = tmp("cs-grants-"), workdir = path.join(dir, "work");
  mkdirSync(workdir);
  writeFileSync(path.join(workdir, "image.png"), TRANSPARENT_PNG);
  writeFileSync(path.join(workdir, "file.txt"), "报告内容", "utf8");
  const store = new ReplyStore(dir), history = new ContextStore(dir);
  const msg: InboundMessage = { message_id: "11", message_type: "group", group_id: "7", user_id: "1", self_id: "2", nickname: "问者",
    time: 1790000000, text: "你好", route_text: "你好", truncated: false, mentioned_self: true, images: [], segments: [] };
  const inputKey = store.admit(msg, "group:7")!;
  let n = 0;
  const call = vi.fn(async (action: string, _params?: Record<string, unknown>) => {
    if (action === "get_login_info") return { user_id: 2 };
    if (action.startsWith("upload_")) return { file_id: "file-" + ++n };
    return { message_id: String(++n) };
  });
  const rules: SendRuleLimits = { ...DEFAULT_SEND_RULES };
  const bridge = createQQBridge({ httpUrl: "http://unused.test", wsUrl: "ws://unused.test", token: "",
    allowUsers: ["1"], owners, allowGroups: ["7", "8"], groupMentions: true, dataDir: dir, imageRoot: path.join(dir, "images"),
    sendRules: () => rules }, { client: { call } });
  clean.push(() => { store.close(); history.close(); }, () => bridge.stop());
  return { dir, workdir, store, history, msg, inputKey, bridge, call, rules };
}

/**
 * 授权测试台：bridgeFixture + 派发 harness 上的 GrantsService。
 * binding 是群 7 中 QQ 1 发起的用户回合（身份由会话宿主给出，设计 §7.3），本轮输入已在 Inbox 中。
 */
export async function grantsFixture(owner = "1", disk = false, owners?: readonly string[]) {
  const { dir, workdir, store, history, msg, inputKey, bridge, call, rules } = bridgeFixture(owners);
  const options = { models: createModels(), extension: defineExtension({ name: "grants-test" }),
    ...(disk ? { dbFile: path.join(dir, "agent.sqlite") } : { storage: new MemoryStorage() }) };
  let harness = await openHarness(options, BACKGROUND_CONTEXT);
  clean.push(() => harness.close(BACKGROUND_CONTEXT));
  let now = Date.now();
  const event = vi.fn();
  const grants = new GrantsService({ getHarness: () => harness, owner, owners, now: () => now, trace: { event } });
  const listChats = vi.spyOn(bridge, "listChats").mockResolvedValue({ groups: [{ group_id: "8", name: "测试群" }], friends: [{ user_id: "9", nickname: "测试好友" }] });
  const binding = { threadKey: "group:7", turnId: "t-grants", identity: { kind: "user" as const, sender: "1" }, scope: "group:7",
    inputKey, inputs: [inputKey] as string[], access: { kind: "scope" as const, scope: "group:7" }, workdir };
  const service = new SendService({ getChannel: () => bridge, dataDir: dir, store: history, grants, now: () => now });
  return { dir, workdir, store, history, msg, inputKey, bridge, call, rules, service, binding, grants, event, listChats, now: () => now,
    advance: (ms: number) => { now += ms; }, setNow: (ms: number) => { now = ms; },
    harness: () => harness,
    reopen: async () => { await harness.close(BACKGROUND_CONTEXT); harness = await openHarness(options, BACKGROUND_CONTEXT); },
  };
}
