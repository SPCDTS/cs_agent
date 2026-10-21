import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createModels } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineTask, type ConversationId } from "@earendil-works/pi-durable";
import { createTasks, type AgentCheckpoint, type TaskInput, type TaskResult } from "../../src/agent/tasks.js";
import { createCsAgentExtension } from "../../src/agent/extension.js";
import { openHarness } from "../../src/agent/harness.js";
import { createBackendSelector } from "../../src/agent/backends/select.js";
import { BackendTimeoutError, type AgentBackend } from "../../src/agent/backends/types.js";
import { Dispatcher, MAX_FILE_REPLY_ATTEMPTS } from "../../src/agent/dispatch.js";
import { DispatchDoc, TicketDoc } from "../../src/agent/docs.js";
import { AGENT_INTERRUPTION_NOTICES, FALLBACK_REPLY, AGENT_FAILURE_REPLIES, IMAGE_SUCCESS_REPLY } from "../../src/agent/replies.js";
import { LiveBus } from "../../src/obs/live.js";
import { trace } from "../../src/shared/trace.js";
import { sendFixture } from "./send-fixture.js";
import { promises as fs } from "node:fs";
import { savePendingImage } from "../../src/media/gen/image-pending.js";
import { TRANSPARENT_PNG } from "../../src/media/gen/image-gen.js";

const context = BACKGROUND_CONTEXT, cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function rig(handle: AgentBackend["handle"], legacy?: "postprocess" | "reply", brokenPhase?: "lateImages" | "settle", backend: "pi" | "codex" = "codex") {
  const f = sendFixture();
  const recordDeliveryNote = vi.fn<NonNullable<AgentBackend["recordDeliveryNote"]>>().mockResolvedValue();
  const events: { stage: string; detail: unknown }[] = [];
  cleanup.push(trace.tap(e => { if (e.ticket === f.ticket) events.push(e); }));
  const tasks = createTasks({ getBridge: () => f.bridge, sendService: f.service, imagesDir: path.join(f.dir, "images"),
    backends: createBackendSelector({ defaultBackend: backend, backends: { [backend]: { name: backend, handle, recordDeliveryNote } }, overrides: {} }),
    imageBackend: { name: "test", submit: async () => "p", collect: async (_id, dir) => {
      await fs.mkdir(dir, { recursive: true }); await fs.writeFile(path.join(dir, "late.png"), TRANSPARENT_PNG); return [];
    }, reconcile: async () => ({ images: [] }), clearReferences: async () => {} }, replyRetryDelayMs: 1 });
  if (brokenPhase) tasks.AgentTask = defineTask<TaskInput, AgentCheckpoint, TaskResult>({
    name: "cs.agent", version: 1, initial: () => ({ phase: "handle" }),
    phases: { ...tasks.AgentTask.definition.phases, [brokenPhase]: async () => { throw new Error("持久阶段故障"); } },
    abort: tasks.AgentTask.definition.abort,
  });
  const dbFile = path.join(f.dir, "agent.sqlite");
  const old = legacy ? defineTask<TaskInput, AgentCheckpoint, TaskResult>({ name: "cs.agent", version: 1,
    initial: () => legacy === "reply" ? { phase: "reply", attempt: 0 } : { phase: "postprocess" },
    phases: tasks.AgentTask.definition.phases, abort: tasks.AgentTask.definition.abort }) : undefined;
  let harness = await openHarness({ models: createModels(), extension: createCsAgentExtension({ ...tasks, ...(old ? { AgentTask: old } : {}) }), dbFile }, context);
  let conversationId: ConversationId | undefined;
  if (old) {
    const conv = await harness.createConversation({ ownership: { kind: "ownerless" }, init: async (tx, id) => {
      conversationId = id;
      Object.assign(await tx.doc(TicketDoc, id), { ticket: f.ticket, route: "agent", text: "原请求", source: f.binding.source,
        agentResult: { ok: true, backend: "codex", text: "旧最终答案", images: [] }, replyDraft: "旧最终答案" });
      const taskId = await tx.createTask(old, { ticket: f.ticket }, { ownership: { kind: "conversation" }, conversationId: id });
      (await tx.doc(DispatchDoc)).pending[f.ticket] = { conversationId: id, taskId, scope: "group:7", attempts: 0 };
    } }, context);
    conversationId = conv.id;
    await harness.close(context);
    harness = await openHarness({ models: createModels(), extension: createCsAgentExtension(tasks), dbFile }, context);
  }
  cleanup.push(() => harness.close(context));
  let dispatcher = new Dispatcher({ harness, bridge: f.bridge, tasks, concurrency: 1, retryDelayMs: 1, history: f.history });
  return { ...f, tasks, get harness() { return harness; }, get dispatcher() { return dispatcher; }, events, conversationId, recordDeliveryNote,
    async reopen() {
      await harness.close(context);
      harness = await openHarness({ models: createModels(), extension: createCsAgentExtension(tasks), dbFile }, context);
      dispatcher = new Dispatcher({ harness, bridge: f.bridge, tasks, concurrency: 1, retryDelayMs: 1, history: f.history });
    },
  };
}

it.each(["ok", "timeout", "failed"] as const)("零发送回合按 %s 兜底；最终回答只保存在文档及 trace", async outcome => {
  const f = await rig(async () => {
    if (outcome === "timeout") throw new BackendTimeoutError("超时");
    if (outcome === "failed") throw new Error("失败");
    return { text: "最终答案不得发送" };
  });
  await f.dispatcher.dispatch(f.msg, f.ticket);
  const row = f.service.rows(f.ticket)[0]!;
  expect(row.key).toBe(f.ticket + "#fallback");
  expect(row.text).toBe(outcome === "ok" ? FALLBACK_REPLY : AGENT_FAILURE_REPLIES[outcome]);
  expect(f.recordDeliveryNote).toHaveBeenCalledExactlyOnceWith({ ticket: f.ticket, threadKey: "group:7", fallback: row.text });
  expect(f.events.filter(e => e.stage === "delivery_note")).toMatchObject([{ detail: { backend: "codex", thread_key: "group:7", fallback: row.text } }]);
  expect(f.events.filter(e => e.stage === "no_send_fallback")).toHaveLength(outcome === "ok" ? 1 : 0);
  if (outcome !== "ok") expect(f.events.filter(e => e.stage === "failed")).toMatchObject([
    { status: "failed", detail: { terminal: true, failure: outcome } },
  ]);
  expect(f.events.find(e => e.stage === "final_answer")?.detail).toEqual({ text: outcome === "ok" ? "最终答案不得发送" : "", sent_messages: 1 });
  expect((await f.bridge.getTicket(f.ticket))?.status).toBe("sent");
  expect((await f.harness.snapshot(DispatchDoc, context))?.pending).toEqual({});
});

it.each(["sending", "uncertain"] as const)("仅有 %s 时后端失败不补兜底，终结入站票据", async status => {
  const f = await rig(async () => { throw new Error("失败"); });
  const row = f.store.reserveOutbox({ ticket: f.ticket, text: "可能已发", images: [], files: [], call_id: "call",
    message_type: "group", target_id: "7", mention_user_id: "1" });
  f.store.markOutboxSending(row.key); if (status === "uncertain") f.store.markOutboxUncertain(row.key);
  await f.dispatcher.dispatch(f.msg, f.ticket);
  expect(f.service.rows(f.ticket)).toHaveLength(1);
  expect(f.events.some(e => e.stage === "no_send_fallback")).toBe(false);
  expect(f.recordDeliveryNote).not.toHaveBeenCalled();
  expect((await f.bridge.getTicket(f.ticket))?.status).toBe("sent");
});

it("迟到图片使用 #late，已发送图片不重复；成功的最终回答不成为发送正文", async () => {
  let f!: Awaited<ReturnType<typeof rig>>;
  f = await rig(async () => {
    const root = path.join(f.dir, "images", f.ticket), dir = path.join(root, "call-1");
    await fs.mkdir(dir, { recursive: true });
    await savePendingImage(root, { backend: "test", filenamePrefix: "late", options: { prompt: "图" }, callDir: dir,
      submittedAt: Date.now(), status: "submitted", prompt_id: "p" });
    return { text: "留存" };
  });
  await f.dispatcher.dispatch(f.msg, f.ticket);
  expect(f.service.rows(f.ticket)).toMatchObject([{ key: f.ticket + "#late", text: IMAGE_SUCCESS_REPLY, status: "sent" }]);
  expect(f.service.rows(f.ticket)[0]!.images).toHaveLength(1);
  expect(f.history.message(f.binding.access, f.service.rows(f.ticket)[0]!.message_id!)?.row.text).toBe(IMAGE_SUCCESS_REPLY);
  expect(f.recordDeliveryNote).not.toHaveBeenCalled();
});

it("兜底预留后发送前失败，提醒只记录一次并使用原兜底正文", async () => {
  const f = await rig(async () => ({ text: "没有发出" }));
  f.call.mockImplementationOnce(async () => ({ user_id: 99 }));
  await f.dispatcher.dispatch(f.msg, f.ticket);
  expect(f.recordDeliveryNote).toHaveBeenCalledExactlyOnceWith({ ticket: f.ticket, threadKey: "group:7", fallback: FALLBACK_REPLY });
  expect(f.events.filter(e => e.stage === "delivery_note")).toHaveLength(1);
  expect(f.service.rows(f.ticket)).toMatchObject([{ key: f.ticket + "#fallback", status: "sent" }]);
});

it("恢复已预留并发出的 fallback，仍补齐原 backend/thread 的提醒", async () => {
  const f = await rig(async () => { throw new Error("不应重跑"); });
  await f.service.system(f.ticket, "fallback", AGENT_FAILURE_REPLIES.failed);
  await f.service.settle(f.ticket);
  const conv = await f.harness.createConversation({ ownership: { kind: "ownerless" }, init: async (tx, id) => {
    Object.assign(await tx.doc(TicketDoc, id), { ticket: f.ticket, route: "agent", source: f.binding.source,
      agentResult: { ok: false, backend: "codex", threadKey: "owner", failure: "failed" } });
    (await tx.doc(DispatchDoc)).pending[f.ticket] = { conversationId: id, scope: "group:7" };
  } }, context);
  const taskId = await f.harness.commit(tx => tx.createTask(f.tasks.AgentTask, { ticket: f.ticket },
    { ownership: { kind: "conversation" }, conversationId: conv.id }), context);
  f.harness.resume();
  await f.harness.waitForTask(taskId, context);
  expect(f.recordDeliveryNote).toHaveBeenCalledExactlyOnceWith({ ticket: f.ticket, threadKey: "owner", fallback: AGENT_FAILURE_REPLIES.failed });
  expect((await f.harness.snapshot(TicketDoc, conv.id, context))?.deliveryNoted).toBe(true);
  expect(f.call.mock.calls.filter(c => c[0] === "send_group_msg")).toHaveLength(1);
});

it("后端完成的图片仅留存；没有 send_message 或迟到任务时使用 fallback", async () => {
  let f!: Awaited<ReturnType<typeof rig>>;
  f = await rig(async () => ({ text: "未调用发送工具", images: [path.join(f.workdir, "image.png")] }));
  await f.dispatcher.dispatch(f.msg, f.ticket);
  expect(f.service.rows(f.ticket)).toMatchObject([{ key: f.ticket + "#fallback", images: [] }]);
});

it("恢复达到尝试上限的票据，已有 Outbox 消息时不补发，清除派发索引", async () => {
  const f = await rig(async () => { throw new Error("不能重跑"); });
  await f.service.send(f.binding, { text: "已发送" }, { callId: "before-crash" });
  await f.harness.createConversation({ ownership: { kind: "ownerless" }, init: async (tx, id) => {
    Object.assign(await tx.doc(TicketDoc, id), { ticket: f.ticket, route: "agent", text: "原请求", source: f.binding.source });
    (await tx.doc(DispatchDoc)).pending[f.ticket] = { conversationId: id, scope: "group:7", attempts: 3, ticketSeq: 1 };
  } }, context);
  await f.dispatcher.recover(); await f.dispatcher.idle();
  expect(f.service.rows(f.ticket)).toHaveLength(1);
  expect((await f.bridge.getTicket(f.ticket))?.status).toBe("sent");
  expect((await f.harness.snapshot(DispatchDoc, context))?.pending).toEqual({});
  expect(f.call.mock.calls.filter(c => c[0] === "send_group_msg")).toHaveLength(1);
});

it.each(["postprocess", "reply"] as const)("升级前持久检查点 %s 由新任务 settle 完成", async phase => {
  const f = await rig(async () => { throw new Error("不得重跑后端"); }, phase);
  // 直接恢复 durable 检查点，覆盖不经 dispatcher 重建任务的升级路径。
  const entry = (await f.harness.snapshot(DispatchDoc, context))!.pending[f.ticket]!;
  f.harness.resume();
  await f.harness.waitForTask(entry.taskId as never, context);
  expect((await f.harness.snapshot(TicketDoc, f.conversationId!, context))?.replyCompleted).toBe(true);
  expect(f.service.rows(f.ticket)[0]!.text).toBe("旧最终答案");
  expect(f.events.some(e => e.stage === "final_answer")).toBe(true);
});


it("模型已发满 3 条，迟到图片仍单独补发，且不再 @ 提问者", async () => {
  let f!: Awaited<ReturnType<typeof rig>>;
  f = await rig(async () => {
    for (const n of [1, 2, 3]) await f.service.send(f.binding, { text: "消息" + n }, { callId: "call-" + n });
    const root = path.join(f.dir, "images", f.ticket), dir = path.join(root, "call-1");
    await fs.mkdir(dir, { recursive: true });
    await savePendingImage(root, { backend: "test", filenamePrefix: "late", options: { prompt: "图" }, callDir: dir,
      submittedAt: Date.now(), status: "submitted", prompt_id: "p" });
    return { text: "最终答案" };
  });
  await f.dispatcher.dispatch(f.msg, f.ticket);
  expect(f.service.rows(f.ticket).map(row => row.key)).toEqual([1, 2, 3, "late"].map(suffix => f.ticket + "#" + suffix));
  expect(f.service.rows(f.ticket).at(-1)).toMatchObject({ status: "sent", mention_user_id: null });
  expect(f.events.some(e => e.stage === "no_send_fallback")).toBe(false);
});

it("3 条模型消息均在发送前失败，仍允许独立 fallback 并终结票据", async () => {
  const f = await rig(async () => ({ text: "未发出" }));
  for (const n of [1, 2, 3]) f.store.reserveOutbox({ ticket: f.ticket, call_id: "pending-" + n,
    text: "发送前失败", images: [], files: [], message_type: "group", target_id: "7", mention_user_id: "1" });
  await f.dispatcher.dispatch(f.msg, f.ticket);
  expect(f.service.rows(f.ticket).map(row => row.status)).toEqual(["pending", "pending", "pending", "sent"]);
  expect(f.service.rows(f.ticket).at(-1)).toMatchObject({ key: f.ticket + "#fallback", text: FALLBACK_REPLY, mention_user_id: "1" });
  expect((await f.bridge.getTicket(f.ticket))?.status).toBe("sent");
});


it.each([false, true])("done 图片仍经 #late 收取，已发送相同哈希时不重复：%s", async alreadySent => {
  let f!: Awaited<ReturnType<typeof rig>>;
  f = await rig(async () => {
    const root = path.join(f.dir, "images", f.ticket), dir = path.join(root, "call-1"), file = path.join(dir, "done.png");
    await fs.mkdir(dir, { recursive: true }); await fs.writeFile(file, TRANSPARENT_PNG);
    await savePendingImage(root, { backend: "test", filenamePrefix: "done", options: { prompt: "图" }, callDir: dir,
      submittedAt: Date.now(), status: "done", prompt_id: "already-complete", remoteTerminal: true });
    if (alreadySent) await f.service.send({ ...f.binding, extraRoots: [root] }, { text: "已生成", images: [file] }, { callId: "sent" });
    return { text: "最终答案" };
  });
  await f.dispatcher.dispatch(f.msg, f.ticket);
  expect(f.service.rows(f.ticket)).toHaveLength(1);
  expect(f.service.rows(f.ticket)[0]!.key).toBe(f.ticket + (alreadySent ? "#1" : "#late"));
  expect(f.service.rows(f.ticket)[0]!.images).toHaveLength(1);
  expect(f.events.some(e => e.stage === "no_send_fallback")).toBe(false);
});

it("旧 postprocess 无草稿时保留最终答案与最多 4 张图片，发送前重试不改为通用兜底", async () => {
  const f = await rig(async () => { throw new Error("不应重跑后端"); }, "postprocess");
  const images: string[] = [];
  for (const n of [1, 2, 3, 4, 5]) {
    const file = path.join(f.dir, "images", f.ticket, n + ".png");
    await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, TRANSPARENT_PNG); images.push(file);
  }
  await f.harness.commit(async tx => {
    const doc = await tx.doc(TicketDoc, f.conversationId!);
    delete doc.replyDraft;
    doc.agentResult = { ok: true, backend: "codex", text: "旧答案".repeat(2000), images };
  }, context);
  f.call.mockImplementationOnce(async () => ({ user_id: 99 }));
  const entry = (await f.harness.snapshot(DispatchDoc, context))!.pending[f.ticket]!;
  f.harness.resume(); await f.harness.waitForTask(entry.taskId as never, context);
  expect(f.service.rows(f.ticket)).toHaveLength(1);
  expect(f.service.rows(f.ticket)[0]).toMatchObject({ key: f.ticket + "#fallback", status: "sent", images: images.slice(0, 4) });
  expect(f.service.rows(f.ticket)[0]!.text).toContain("旧答案");
  expect(f.service.rows(f.ticket)[0]!.text.length).toBeLessThanOrEqual(4000);
  expect(f.events.some(e => e.stage === "no_send_fallback")).toBe(false);
});

it("有 replyDraft 的重建任务沿用旧草稿，不要求仍处于旧检查点", async () => {
  const f = await rig(async () => { throw new Error("不应重跑后端"); });
  await f.harness.createConversation({ ownership: { kind: "ownerless" }, init: async (tx, id) => {
    Object.assign(await tx.doc(TicketDoc, id), { ticket: f.ticket, route: "agent", text: "原请求", source: f.binding.source,
      replyDraft: "已完成的草稿", agentResult: { ok: true, backend: "codex", text: "原文", images: [] } });
    (await tx.doc(DispatchDoc)).pending[f.ticket] = { conversationId: id, scope: "group:7", attempts: 0 };
  } }, context);
  await f.dispatcher.recover(); await f.dispatcher.idle();
  expect(f.service.rows(f.ticket)[0]!.text).toBe("已完成的草稿");
  expect(f.events.some(e => e.stage === "no_send_fallback")).toBe(false);
});

it.each(["sent", "sending", "uncertain"] as const)("已 %s 票据重入 settle 跳过系统补发及已删除图片的哈希读取", async status => {
  const f = await rig(async () => { throw new Error("不能重跑"); }, "reply");
  await f.service.send(f.binding, { text: "已发", images: ["image.png"] }, { callId: "a" });
  if (status === "sent") await f.service.settle(f.ticket);
  else { f.store.markSending(f.ticket); if (status === "uncertain") f.store.markUncertain(f.ticket); }
  await f.service.cleanup(f.ticket);
  await f.harness.commit(async tx => {
    (await tx.doc(TicketDoc, f.conversationId!)).lateImageJobs = [{ backend: "test", filenamePrefix: "late",
      options: { prompt: "图" }, callDir: path.join(f.dir, "gone"), submittedAt: 1, extensions: 0, status: "done",
      result: { ok: true, images: [path.join(f.dir, "不存在.png")] } }];
  }, context);
  const system = vi.spyOn(f.service, "system");
  const entry = (await f.harness.snapshot(DispatchDoc, context))!.pending[f.ticket]!;
  f.harness.resume(); await f.harness.waitForTask(entry.taskId as never, context);
  expect(system).not.toHaveBeenCalled();
  expect((await f.harness.snapshot(TicketDoc, f.conversationId!, context))!.replyCompleted).toBe(true);
  expect(f.call.mock.calls.filter(c => c[0] === "send_group_msg")).toHaveLength(1);
});

it("settle 的异常恢复遇到 reconcile 持续抛错也能终结，不在 catch 再抛", async () => {
  const f = await rig(async () => ({ text: "留存" }));
  await f.service.send(f.binding, { text: "已发" }, { callId: "a" });
  const reconcile = vi.spyOn(f.service, "reconcile").mockRejectedValue(new Error("存储不可用"));
  await f.dispatcher.dispatch(f.msg, f.ticket);
  expect(reconcile).toHaveBeenCalled();
  expect(f.events.some(e => e.stage === "final_answer")).toBe(true);
  expect((await f.bridge.getTicket(f.ticket))!.status).toBe("sent");
  expect((await f.harness.snapshot(DispatchDoc, context))!.pending).toEqual({});
});

it("lateImages 持续失败且已有 sent 行时由派发 fallback 对账终结，reconcile 失败也不补发", async () => {
  const f = await rig(async () => ({ text: "留存" }), undefined, "lateImages");
  await f.service.send(f.binding, { text: "已发" }, { callId: "a" });
  vi.spyOn(f.service, "reconcile").mockRejectedValue(new Error("存储不可用"));
  await f.dispatcher.dispatch(f.msg, f.ticket);
  expect((await f.bridge.getTicket(f.ticket))!.status).toBe("sent");
  expect((await f.harness.snapshot(DispatchDoc, context))!.pending).toEqual({});
  expect(f.service.rows(f.ticket)).toHaveLength(1);
  expect(f.events.filter(e => e.stage === "dispatched")).toHaveLength(1);
});

it.each([false, true])("附件恢复始终失败也有上限并放行同 scope 下一条，票据已 sent=%s", async settled => {
  const f = await rig(async () => ({ text: "留存" }), undefined, settled ? "settle" : "lateImages");
  const control = new AbortController(), original = f.bridge.send.bind(f.bridge);
  const send = vi.spyOn(f.bridge, "send").mockImplementation(async (...args) => {
    const result = await original(...args); control.abort(); return result;
  });
  await expect(f.service.send(f.binding, { text: "待上传", files: [{ path: "file.txt" }] }, { callId: "a" }, control.signal)).rejects.toThrow();
  send.mockRestore();
  if (settled) await f.service.settle(f.ticket);
  const reconcile = f.service.reconcile.bind(f.service);
  vi.spyOn(f.service, "reconcile").mockImplementation((ticket, signal) => {
    if (ticket === f.ticket) return Promise.reject(new Error("附件存储故障"));
    return reconcile(ticket, signal);
  });
  const next = { ...f.msg, message_id: "next", text: "后一条", route_text: "后一条" }, nextTicket = f.store.createTicket(next);
  await Promise.all([f.dispatcher.dispatch(f.msg, f.ticket), f.dispatcher.dispatch(next, nextTicket)]);
  expect((await f.harness.snapshot(DispatchDoc, context))!.pending).toEqual({});
  expect(f.events.filter(e => e.stage === "dispatched")).toHaveLength(MAX_FILE_REPLY_ATTEMPTS);
  expect((await f.bridge.getTicket(nextTicket))!.status).toBe("sent");
  await expect(fs.stat(f.service.rows(f.ticket)[0]!.files[0]!.filename)).resolves.toBeDefined();
  expect(f.dispatcher.status()).toMatchObject({ active: 0, waiting: 0 });
});


it("旧检查点先保存兼容答案，对账异常后切到 settle 重试仍发送旧答案", async () => {
  const f = await rig(async () => { throw new Error("不应重跑"); }, "postprocess");
  await f.harness.commit(async tx => { delete (await tx.doc(TicketDoc, f.conversationId!)).replyDraft; }, context);
  vi.spyOn(f.service, "reconcile").mockRejectedValueOnce(new Error("第一次对账失败"));
  const entry = (await f.harness.snapshot(DispatchDoc, context))!.pending[f.ticket]!;
  f.harness.resume(); await f.harness.waitForTask(entry.taskId as never, context);
  expect(f.service.rows(f.ticket)[0]).toMatchObject({ key: f.ticket + "#fallback", text: "旧最终答案", status: "sent" });
  expect(f.events.some(e => e.stage === "no_send_fallback")).toBe(false);
});

it.each([
  { backend: "pi", failure: "timeout", count: 1, notice: "这次处理超时中断了，后续结果没能发出。" },
  { backend: "pi", failure: "failed", count: 3, notice: "这次处理中途出错了，后续结果没能发出。" },
  { backend: "codex", failure: "timeout", count: 3, notice: "这次处理超时中断了，后续结果没能发出。" },
  { backend: "codex", failure: "failed", count: 1, notice: "这次处理中途出错了，后续结果没能发出。" },
] as const)("$backend 已发 $count 条后 $failure：独立通知且保留失败分类", async ({ backend, failure, count, notice }) => {
  let f!: Awaited<ReturnType<typeof rig>>;
  f = await rig(async (_req, ctx) => {
    if (backend === "pi") await ctx.persistPiTurn!({ requestId: f.ticket, retries: 0, conversationId: 123 });
    for (let n = 1; n <= count; n++) await f.service.send(f.binding, { text: "处理中" + n }, { callId: "send-" + n });
    throw failure === "timeout" ? new BackendTimeoutError("超时") : new Error("后端失败");
  }, undefined, undefined, backend);
  const live = new LiveBus(trace);
  cleanup.push(() => live.close());
  await f.dispatcher.dispatch(f.msg, f.ticket);
  const rows = f.service.rows(f.ticket);
  expect(rows).toHaveLength(count + 1);
  expect(rows.at(-1)).toMatchObject({ key: f.ticket + "#fallback", status: "sent", text: notice,
    message_type: "group", target_id: "7", mention_user_id: null, proactive: false });
  expect(f.call.mock.calls.filter(c => c[0] === "send_group_msg")).toHaveLength(count + 1);
  expect(f.store.countModelOutbox("group", "7", "2000-01-01T00:00:00.000Z", "2100-01-01T00:00:00.000Z")).toBe(0);
  expect(f.events.filter(e => e.stage === "failed")).toMatchObject([
    { status: "failed", detail: { terminal: true, backend, failure, reply: notice } },
  ]);
  expect(f.events.some(e => ["reply_sent", "no_send_fallback", "delivery_note"].includes(e.stage))).toBe(false);
  const card = live.snapshot().find(card => card.ticket === f.ticket);
  expect(card).toMatchObject({ state: "failed", outcome: "failed", backend });
  expect(card?.items.at(-1)?.summary).toContain(failure);
  expect(f.recordDeliveryNote).not.toHaveBeenCalled();
  expect((await f.bridge.getTicket(f.ticket))?.status).toBe("sent");
  expect((await f.harness.snapshot(DispatchDoc, context))?.pending).toEqual({});
});

it.each(["absent", "pending", "sent", "sending", "uncertain", "settled"] as const)("中断通知在 %s 阶段重启后幂等恢复", async status => {
  const handle = vi.fn<AgentBackend["handle"]>().mockRejectedValue(new Error("不得重跑后端"));
  const f = await rig(handle);
  await f.service.send(f.binding, { text: "正在收集数据" }, { callId: "promise" });
  if (status === "sent" || status === "settled") {
    await f.service.system(f.ticket, "fallback", AGENT_INTERRUPTION_NOTICES.timeout);
    if (status === "settled") await f.service.settle(f.ticket);
  } else if (status !== "absent") {
    const row = f.store.reserveOutbox({ ticket: f.ticket, suffix: "fallback", call_id: null,
      text: AGENT_INTERRUPTION_NOTICES.timeout, images: [], files: [], message_type: "group", target_id: "7", mention_user_id: null });
    if (status !== "pending") f.store.markOutboxSending(row.key);
    if (status === "uncertain") f.store.markOutboxUncertain(row.key);
  }
  const conv = await f.harness.createConversation({ ownership: { kind: "ownerless" }, init: async (tx, id) => {
    Object.assign(await tx.doc(TicketDoc, id), { ticket: f.ticket, route: "agent", source: f.binding.source,
      agentResult: { ok: false, backend: "codex", threadKey: "group:7", failure: "timeout" } });
    (await tx.doc(DispatchDoc)).pending[f.ticket] = { conversationId: id, scope: "group:7", attempts: 0 };
  } }, context);
  await f.reopen();
  await f.dispatcher.recover(); await f.dispatcher.idle();
  await f.dispatcher.dispatch(f.msg, f.ticket);
  expect(handle).not.toHaveBeenCalled();
  expect(f.service.rows(f.ticket)).toHaveLength(2);
  expect(f.service.rows(f.ticket).at(-1)?.text).toBe(AGENT_INTERRUPTION_NOTICES.timeout);
  expect(f.call.mock.calls.filter(c => c[0] === "send_group_msg")).toHaveLength(["sending", "uncertain"].includes(status) ? 1 : 2);
  expect(f.recordDeliveryNote).not.toHaveBeenCalled();
  expect((await f.harness.snapshot(TicketDoc, conv.id, context))?.deliveryNoted).not.toBe(true);
  expect((await f.harness.snapshot(TicketDoc, conv.id, context))?.agentResult).toMatchObject({ ok: false, failure: "timeout" });
  expect((await f.bridge.getTicket(f.ticket))?.status).toBe("sent");
});

it.each(["before-reserve", "after-reserve"] as const)("中断通知在 %s 失败后重试，仍只发送一次", async phase => {
  let f!: Awaited<ReturnType<typeof rig>>;
  f = await rig(async () => {
    await f.service.send(f.binding, { text: "正在处理" }, { callId: "promise" });
    if (phase === "before-reserve") vi.spyOn(f.service, "system").mockRejectedValueOnce(new Error("预留暂不可用"));
    else vi.spyOn(f.bridge, "send").mockRejectedValueOnce(new Error("发送前失败"));
    throw new BackendTimeoutError("超时");
  });
  await f.dispatcher.dispatch(f.msg, f.ticket);
  expect(f.service.rows(f.ticket)).toHaveLength(2);
  expect(f.service.rows(f.ticket).at(-1)).toMatchObject({ key: f.ticket + "#fallback", status: "sent", text: AGENT_INTERRUPTION_NOTICES.timeout });
  expect(f.call.mock.calls.filter(c => c[0] === "send_group_msg")).toHaveLength(2);
  expect(f.recordDeliveryNote).not.toHaveBeenCalled();
});
