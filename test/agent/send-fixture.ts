import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, vi } from "vitest";
import { ReplyStore } from "../../src/qq/reply-store.js";
import { createQQBridge } from "../../src/qq/bridge.js";
import { SendService, type SendBinding } from "../../src/agent/send-service.js";
import { ContextStore } from "../../src/context/store.js";
import { TRANSPARENT_PNG } from "../../src/media/gen/image-gen.js";
import type { InboundMessage, TurnIdentity } from "../../src/channel/types.js";
import { threadKeyOf } from "../../src/channel/ticket.js";
import { DEFAULT_SEND_RULES, type SendRuleLimits } from "../../src/channel/send-rules.js";
import { tmp } from "./helpers.js";

const clean: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of clean.splice(0).reverse()) await fn(); });

/**
 * 会话绑定的发送装置：一条已落盘的入站输入（发送者 1），本轮绑定 = 该输入所在会话、user 身份、回合 t1。
 * mention 模拟 ThreadHost.takeMention：每个回合（turnId）只 @ 一次。
 */
export function sendFixture(group = true, owners?: readonly string[]) {
  const dir = tmp("cs-send-"), workdir = path.join(dir, "work");
  mkdirSync(workdir);
  writeFileSync(path.join(workdir, "image.png"), TRANSPARENT_PNG);
  writeFileSync(path.join(workdir, "file.txt"), "报告内容", "utf8");
  const store = new ReplyStore(dir), history = new ContextStore(dir);
  const msg: InboundMessage = { message_id: "11", message_type: group ? "group" : "private", group_id: group ? "7" : null,
    user_id: "1", self_id: "2", nickname: "问者", time: 1790000000, text: "你好", route_text: "你好", truncated: false,
    mentioned_self: group, images: [], segments: [] };
  const threadKey = threadKeyOf(msg, owners);
  const key = store.admit(msg, threadKey)!;
  let n = 0;
  const call = vi.fn(async (action: string, _params?: Record<string, unknown>) => {
    if (action === "get_login_info") return { user_id: 2 };
    if (action.startsWith("upload_")) return { file_id: "file-" + ++n };
    if (action === "get_group_list") return [{ group_id: 7, group_name: "七" }, { group_id: 8, group_name: "八" }];
    if (action === "get_friend_list") return [{ user_id: 1, nickname: "一" }, { user_id: 5, nickname: "五" }];
    return { message_id: String(++n) };
  });
  // 发送规则可在用例内就地修改；clock 未设置时用真实时间。
  const rules: SendRuleLimits = { ...DEFAULT_SEND_RULES };
  const clock: { now?: number } = {};
  const bridge = createQQBridge({ httpUrl: "http://unused.test", wsUrl: "ws://unused.test", token: "",
    allowUsers: ["1"], owners, allowGroups: ["7", "8"], groupMentions: true, dataDir: dir, imageRoot: path.join(dir, "images"),
    sendRules: () => rules }, { client: { call }, now: () => clock.now ?? Date.now() });
  const mentioned = new Set<string>();
  const turn = { id: "t1" };
  const service = new SendService({ getChannel: () => bridge, dataDir: dir, store: history,
    mention: async () => mentioned.has(turn.id) ? false : (mentioned.add(turn.id), "1") });
  clean.push(() => { store.close(); history.close(); }, () => bridge.stop());
  const scope = group ? "group:7" : "private:1";
  const bindingFor = (identity: TurnIdentity = { kind: "user", sender: "1" }, turnId = turn.id): SendBinding => ({
    threadKey, identity, scope, turnId, inputKey: key, inputs: [key], workdir,
    access: { kind: "scope" as const, scope },
  });
  const binding = bindingFor();
  return { dir, workdir, store, history, msg, key, threadKey, bridge, service, binding, bindingFor, turn, call, rules, clock };
}
