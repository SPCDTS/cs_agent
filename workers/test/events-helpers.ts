import { env, runInDurableObject } from "cloudflare:test";
import { vi } from "vitest";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import type { JsonObject } from "@earendil-works/pi-durable";
import * as models from "../src/models";

// 全部为合成测试值，不读取开发机或线上凭据。
type Mail = { id: string; from: string; subject: string; snippet: string; labels: string[]; body?: string };
export function fakeGoogle() {
  const state = {
    historyId: 100, history: [] as { id: number; messages: string[] }[], mail: new Map<string, Mail>(),
    historyStatus: 200, failGmail: false, pageSize: 100, sends: 0, tokenRequests: 0, watches: 0, jwks: undefined as unknown,
    requests: [] as string[], missing: new Set<string>(),
  };
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url);
    state.requests.push(`${request.method} ${url.href}`);
    if (url.href === "https://www.googleapis.com/oauth2/v3/certs") return Response.json(state.jwks);
    if (url.href === "https://oauth2.googleapis.com/token") { state.tokenRequests++; return Response.json({ access_token: "synthetic-gmail-access", expires_in: 3600 }); }
    if (url.origin !== "https://gmail.googleapis.com") throw new Error("unexpected_test_destination");
    if (request.headers.get("Authorization") !== "Bearer synthetic-gmail-access") return new Response(null, { status: 401 });
    if (state.failGmail) return new Response("synthetic-upstream-detail", { status: 503 });
    const path = url.pathname.replace("/gmail/v1/users/me/", "");
    if (path === "profile") return Response.json({ historyId: String(state.historyId) });
    if (path === "watch") { state.watches++; return Response.json({ historyId: String(state.historyId), expiration: String(Date.now() + 7 * 86_400_000) }); }
    if (path === "history") {
      if (state.historyStatus !== 200) return new Response(null, { status: state.historyStatus });
      const start = Number(url.searchParams.get("startHistoryId")), offset = Number(url.searchParams.get("pageToken") ?? 0);
      const records = state.history.filter(record => record.id > start), page = records.slice(offset, offset + state.pageSize);
      return Response.json({ historyId: String(state.historyId), history: page.map(record => ({ id: String(record.id), messagesAdded: record.messages.map(id => ({ message: { id } })) })),
        ...(offset + state.pageSize < records.length ? { nextPageToken: String(offset + state.pageSize) } : {}) });
    }
    if (path === "messages" && request.method === "GET") {
      return Response.json({ messages: [...state.mail.values()].slice(0, Number(url.searchParams.get("maxResults"))).map(mail => ({ id: mail.id, threadId: "thread-" + mail.id })) });
    }
    if (path === "messages/send") { state.sends++; return Response.json({ id: `sent-${state.sends}`, threadId: "thread-sent" }); }
    const id = /^messages\/([^/]+)$/.exec(path)?.[1], mail = id ? state.mail.get(id) : undefined;
    if (!id || !mail || state.missing.has(id)) return new Response(null, { status: 404 });
    const headers = [{ name: "From", value: mail.from }, { name: "Subject", value: mail.subject }, { name: "Date", value: "Tue, 27 Oct 2026 08:18:00 +0000" }, { name: "Message-ID", value: `<${id}@mail.test>` }];
    return Response.json({ id, threadId: "thread-" + id, snippet: mail.snippet, labelIds: mail.labels, internalDate: "1793089080000",
      payload: { mimeType: "multipart/mixed", headers, parts: [
        { mimeType: "text/plain", body: { data: Buffer.from(mail.body ?? "正文", "utf8").toString("base64url") } },
        { mimeType: "application/pdf", filename: "report.pdf", body: { attachmentId: "att", size: 2048 } },
      ] } });
  });
  function addMail(id: string, mail: Partial<Omit<Mail, "id">> = {}, record = true) {
    state.mail.set(id, { id, from: "Alice <alice@example.test>", subject: "主题 " + id, snippet: "摘要 " + id, labels: ["INBOX"], ...mail });
    state.historyId += 1;
    if (record) state.history.push({ id: state.historyId, messages: [id] });
  }
  return { state, spy, addMail };
}

export function sql<T>(query: string, ...args: unknown[]): Promise<T[]> {
  return runInDurableObject(env.EVENTS.getByName("main"), (_instance, state) => state.storage.sql.exec<T & Record<string, SqlStorageValue>>(query, ...args).toArray());
}

/** 模型脚本：每次请求先记录当前可用工具（重放 toolsAdded/toolsRemoved）和最后一条用户输入，再按步骤调用工具。 */
export function scriptedModel(steps: { name: string; args: JsonObject }[]) {
  const faux = fauxProvider({ models: [{ id: "test" }], tokensPerSecond: Infinity });
  const requests: { tools: string[]; user: string; sections: Record<string, string | null> }[] = [], outputs: string[] = [], captured = new Set<string>();
  const respond: FauxResponseFactory = transcript => {
    faux.setResponses([respond]);
    const tools = new Set<string>();
    const sections: Record<string, string | null> = {};
    for (const message of transcript.messages) if (message.role === "system") {
      Object.assign(sections, message.sections);
      for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
      for (const tool of message.toolsAdded ?? []) tools.add(tool.name);
    }
    const user = transcript.messages.findLast(message => message.role === "user");
    requests.push({ tools: [...tools], sections, user: typeof user?.content === "string" ? user.content : user?.content.map(block => block.type === "text" ? block.text : "").join("") ?? "" });
    const last = transcript.messages.findLast(message => message.role === "toolResult");
    if (last?.role === "toolResult" && !captured.has(last.toolCallId)) {
      captured.add(last.toolCallId);
      outputs.push(last.content.filter(block => block.type === "text").map(block => block.text).join(""));
    }
    const latest = transcript.messages.findLast(message => message.role !== "system");
    if (latest?.role === "user" || latest?.role === "toolResult") {
      const next = steps.shift();
      // 空名字表示本回合到此结束，后续步骤留给下一回合。
      if (next?.name) return fauxAssistantMessage(fauxToolCall(next.name, next.args), { stopReason: "toolUse" });
    }
    return fauxAssistantMessage("done");
  };
  faux.setResponses([respond]);
  vi.spyOn(models, "openModels").mockImplementation((_env, credentials) => {
    const registry = createModels({ credentials }); registry.setProvider(faux.provider);
    return registry;
  });
  return { requests, outputs, steps };
}
