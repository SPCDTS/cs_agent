import { MEMORY_EXTRACT_PROMPT } from "../src/memory/extractor";
import { env, runInDurableObject } from "cloudflare:test";
import { expect, vi } from "vitest";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, fauxToolCall, fauxText, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import type { JsonObject } from "@earendil-works/pi-durable";
import worker from "../src/index";
import * as models from "../src/models";
import { MediaRepository, scopePrefix } from "../src/media/repository";
import { sha256 } from "../src/media/model";
import type { SubagentView } from "../src/subagent/parent";
import { syncedView } from "./helpers";

export const TOKEN = "test-admin-only";

/** 一步：调工具、给最终文字（可等闸门打开再答）、或一直挂起到被中止；函数步按已有的工具输出求出下一步。 */
export type Step = { tool: string; args: JsonObject; progress?: string; after?: Promise<void> } | { text: string; after?: Promise<void> } | "hang" | ((outputs: string[]) => Step);
export type Seen = { tools: string[]; user: string; identity: string };

/** 父线程与子 agent 共用一个 faux provider；按系统段里有没有 subagent 段分流到各自的脚本。 */
export function twoModels(parentSteps: Step[], childSteps: Step[]) {
  const faux = fauxProvider({ models: [{ id: "test" }], tokensPerSecond: Infinity });
  const seen = { parent: [] as Seen[], child: [] as Seen[] }, outputs = { parent: [] as string[], child: [] as string[] };
  const captured = new Set<string>();
  const respond: FauxResponseFactory = async (transcript, options) => {
    faux.setResponses([respond]);
    if (transcript.messages.some(message => message.role === "user" && typeof message.content === "string" && message.content.startsWith(MEMORY_EXTRACT_PROMPT))) return fauxAssistantMessage("[]");
    let role: "parent" | "child" = "parent", identity = "";
    const tools = new Set<string>();
    for (const message of transcript.messages) {
      if (message.role !== "system") continue;
      if (message.sections?.subagent) role = "child";
      if (message.sections && "turn-identity" in message.sections) identity = message.sections["turn-identity"] ?? "";
      for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
      for (const tool of message.toolsAdded ?? []) tools.add(tool.name);
    }
    for (const message of transcript.messages) if (message.role === "toolResult" && !captured.has(message.toolCallId)) {
      captured.add(message.toolCallId);
      outputs[role].push(message.content.filter(block => block.type === "text").map(block => block.text).join(""));
    }
    const user = transcript.messages.findLast(message => message.role === "user");
    seen[role].push({ tools: [...tools], identity,
      user: typeof user?.content === "string" ? user.content : user?.content.map(block => block.type === "text" ? block.text : "").join("") ?? "" });
    // 段落变化（如本回合身份）以系统消息追加在用户输入之后，按最后一条非系统消息判断轮到谁。
    const last = transcript.messages.findLast(message => message.role !== "system")?.role;
    let step = last === "user" || last === "toolResult" ? (role === "parent" ? parentSteps : childSteps).shift() : undefined;
    while (typeof step === "function") step = step(outputs[role]);
    if (step === "hang") {
      return new Promise((_resolve, reject) => {
        const signal = options?.signal;
        if (signal?.aborted) reject(new Error("aborted"));
        signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    }
    if (step) await step.after;
    if (step && "tool" in step) return fauxAssistantMessage([...(step.progress ? [fauxText(step.progress)] : []), fauxToolCall(step.tool, step.args)], { stopReason: "toolUse" });
    if (step) return fauxAssistantMessage(step.text);
    return fauxAssistantMessage("done");
  };
  faux.setResponses([respond]);
  vi.spyOn(models, "openModels").mockImplementation((_env, credentials) => {
    const registry = createModels({ credentials });
    registry.setProvider(faux.provider);
    return registry;
  });
  return { seen, outputs };
}

export const thread = (key: string) => env.THREAD.getByName(key);
export const child = (key: string, id: string) => env.SUBAGENT.getByName(`sub:${key}:${id}`);
export const rows = <T>(key: string, query: string, ...args: (string | number)[]) => runInDurableObject(thread(key), (_instance, state) =>
  state.storage.sql.exec<T & Record<string, SqlStorageValue>>(query, ...args).toArray() as T[]);
export const spawn = (task: string, extra: JsonObject = {}): Step => ({ tool: "subagent", args: { action: "spawn", task, ...extra } });
export const idOf = (output: string | undefined) => /子 agent ([0-9a-f-]{36})/.exec(output ?? "")?.[1] ?? "";

export async function onlySubagent(key: string): Promise<SubagentView> {
  const list = await (await syncedView(key)).subagentList();
  expect(list).toHaveLength(1);
  return list[0]!;
}

export async function reports(key: string, count: number) {
  await vi.waitFor(async () => expect(await rows(key, "SELECT 1 FROM inbound WHERE kind = 'subagent' AND status = 'done'")).toHaveLength(count), { timeout: 10_000 });
  return rows<{ message_id: string; text: string; turn_id: string; user_id: string }>(key, "SELECT * FROM inbound WHERE kind = 'subagent' ORDER BY rowid");
}

export function gate() {
  let open = () => {};
  const promise = new Promise<void>(resolve => { open = resolve; });
  return { promise, open };
}

export function admin(method: string, path: string, token: string | null = TOKEN) {
  return worker.fetch(new Request(`https://test${path}`, { method, headers: token === null ? {} : { Authorization: `Bearer ${token}` } }), { ...env, ADMIN_TOKEN: TOKEN });
}

export async function seedPublishSkill(workspace = "owner") {
  const sandbox = env.SANDBOX.getByName(workspace), current = await sandbox.files();
  const texts = { "skills/example/SKILL.md": "---\nname: example\ndescription: 测试技能发布\n---\n读取 sources.md。", "skills/example/sources.md": "中文来源说明" };
  const files = await Promise.all(Object.entries(texts).map(async ([path, text]) => {
    const bytes = new TextEncoder().encode(text), digest = await sha256(bytes);
    await env.ASSETS.put((await scopePrefix(current.workspace)) + "/workspace/blobs/" + digest, bytes);
    return { path, sha256: digest, bytes: bytes.length, mime: "text/plain", mode: 420 };
  }));
  const result = await sandbox.importSnapshot({
    expectedRevision: current.revision,
    manifest: { ...current, files, directories: ["skills", "skills/example"], totalBytes: files.reduce((sum, file) => sum + file.bytes, 0) },
  });
  expect(result.ok).toBe(true);
}
