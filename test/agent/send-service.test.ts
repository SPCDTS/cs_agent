import { existsSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SendService } from "../../src/agent/send-service.js";
import { sendFixture } from "./send-fixture.js";
import { trace } from "../../src/shared/trace.js";
import { MediaRecall } from "../../src/context/media.js";

describe("Outbox 与统一发送", () => {
  it("pi 同 call_id 重放返回原回执；并行分配序号，只有首条 @，引用命中每条真实消息", async () => {
    const f = sendFixture();
    const first = await f.service.send(f.binding, { text: "第一条", images: ["image.png"] }, { callId: "call-1" });
    expect(await f.service.send(f.binding, { text: "重放措辞" }, { callId: "call-1" })).toMatchObject({ message_id: first.message_id, already_sent: true });
    await Promise.all([2, 3].map(i => f.service.send(f.binding, { text: "消息" + i }, { callId: "call-" + i })));
    const messages = f.call.mock.calls.filter(([a]) => a === "send_group_msg");
    expect(messages).toHaveLength(3);
    expect((messages[0]![1]!.message as { type: string }[]).map(m => m.type)).toEqual(["at", "text", "image"]);
    expect((messages[1]![1]!.message as { type: string }[]).map(m => m.type)).toEqual(["text"]);
    expect(f.store.listOutbox(f.ticket).map(r => r.ordinal)).toEqual([1, 2, 3]);
    for (const row of f.store.listOutbox(f.ticket)) expect(f.history.message(f.binding.access, row.message_id!)?.row.text).toBe(row.text);
    expect((await f.bridge.getTicket(f.ticket))?.status).toBe("pending");
    await f.service.settle(f.ticket);
    expect((await f.bridge.getTicket(f.ticket))?.status).toBe("sent");
    await expect(f.service.send(f.binding, { text: "第四条" }, { callId: "4" })).rejects.toThrow("3 条");
  });

  it("codex 新尝试的第 n 次映射原行，重建网关仍不重发且不多占限额", async () => {
    const f = sendFixture(false);
    const a = await f.service.send(f.binding, { text: "原文" }, { attempt: "a" });
    await f.service.send(f.binding, { text: "第二条" }, { attempt: "a" });
    const recovered = new SendService({ getChannel: () => f.bridge, dataDir: f.dir });
    expect(await recovered.send(f.binding, { text: "改变措辞" }, { attempt: "b" })).toMatchObject({ already_sent: true, message_id: a.message_id });
    await recovered.send(f.binding, { text: "改变第二条" }, { attempt: "b" });
    await recovered.send(f.binding, { text: "第三条" }, { attempt: "b" });
    expect(f.store.listOutbox(f.ticket).map(r => r.text)).toEqual(["原文", "第二条", "第三条"]);
    await expect(recovered.send(f.binding, { text: "超额" }, { attempt: "b" })).rejects.toThrow("3 条");
  });

  it.each(["sending", "uncertain"] as const)("%s 不重发、不补兜底且可终结入站票据", async status => {
    const f = sendFixture();
    const row = f.store.reserveOutbox({ ticket: f.ticket, call_id: "stable", text: "先前消息", images: [], files: [],
      message_type: "group", target_id: "7", mention_user_id: "1" });
    f.store.markOutboxSending(row.key);
    if (status === "uncertain") f.store.markOutboxUncertain(row.key);
    await expect(f.service.send(f.binding, { text: "再试" }, { callId: "stable" })).resolves.toMatchObject({ status, note: expect.stringContaining("不要重发") });
    expect(f.call).not.toHaveBeenCalled();
    await f.service.settle(f.ticket);
    expect((await f.bridge.getTicket(f.ticket))?.status).toBe("sent");
  });

  it("发送失败后为 uncertain；登录校验失败仍 pending，可安全重试", async () => {
    const f = sendFixture();
    f.call.mockImplementationOnce(async () => ({ user_id: 99 }));
    await expect(f.service.send(f.binding, { text: "正文" }, { callId: "a" })).rejects.toThrow("登录账号");
    expect(f.service.rows(f.ticket)[0]!.status).toBe("pending");
    f.call.mockImplementationOnce(async () => ({ user_id: 2 })).mockRejectedValueOnce(new Error("network"));
    await expect(f.service.send(f.binding, { text: "正文" }, { callId: "a" })).resolves.toMatchObject({ status: "uncertain", note: expect.stringContaining("不要重发") });
    expect(f.service.rows(f.ticket)[0]!.status).toBe("uncertain");
    expect(f.store.markOutboxSending(f.ticket + "#1")).toBe(false);
  });

  it("正文先发，文件各自落盘；恢复 pending 上传、sending 转 uncertain，不重复上传", async () => {
    const f = sendFixture();
    await f.service.send(f.binding, { text: "报告", files: [{ path: "file.txt", name: "报告.txt" }] }, { callId: "f" });
    expect(f.call.mock.calls.map(c => c[0])).toEqual(["get_login_info", "send_group_msg", "upload_group_file"]);
    expect(f.service.rows(f.ticket)[0]!.files[0]).toMatchObject({ status: "sent", file_id: "file-2", name: "报告.txt" });
    await f.service.send(f.binding, { text: "报告" }, { callId: "f" });
    expect(f.call.mock.calls.filter(c => c[0].startsWith("upload"))).toHaveLength(1);
    const raw = f.store.reserveOutbox({ ticket: f.ticket, call_id: "crash", text: "恢复", images: [],
      message_type: "group", target_id: "7", mention_user_id: null,
      files: [f.service.rows(f.ticket)[0]!.files[0]!, f.service.rows(f.ticket)[0]!.files[0]!].map(file => ({ ...file, status: "pending", file_id: undefined })) });
    f.store.markOutboxSending(raw.key); f.store.markOutboxSent(raw.key, "old");
    f.store.updateOutboxFile(raw.key, 0, "sending");
    await f.service.reconcile(f.ticket);
    expect(f.store.getOutbox(raw.key)!.files.map(x => x.status)).toEqual(["uncertain", "sent"]);
    expect(f.call.mock.calls.filter(c => c[0].startsWith("upload"))).toHaveLength(2);
  });

  it.each([
    { text: "" }, { text: "x".repeat(4001) }, { text: "正文", images: Array(5).fill("image.png") },
    { text: "正文", files: Array(4).fill({ path: "file.txt" }) }, { text: "正文", target: "group:8" },
    { text: "正文", images: ["../secret.png"] }, { text: "正文", files: [{ path: "bad.exe" }] },
  ])("校验失败不建行、不截断：%j", async args => {
    const f = sendFixture();
    writeFileSync(path.join(f.workdir, "bad.exe"), "blocked");
    await expect(f.service.send(f.binding, args, { callId: "bad" })).rejects.toThrow();
    expect(f.service.rows(f.ticket)).toHaveLength(0); expect(f.call).not.toHaveBeenCalled();
  });

  it("文件上限、目录、跨工作区与软链接不扩大来源权限", async () => {
    const f = sendFixture();
    writeFileSync(path.join(f.workdir, "large.txt"), Buffer.alloc(20 * 1024 * 1024 + 1));
    mkdirSync(path.join(f.workdir, "folder"));
    symlinkSync(f.workdir, path.join(f.workdir, "link"), "junction");
    for (const file of ["large.txt", "folder", "link/file.txt", "../qq-bridge.sqlite"]) {
      await expect(f.service.send(f.binding, { text: "文件", files: [{ path: file }] }, { callId: file })).rejects.toThrow();
    }
    expect(f.service.rows(f.ticket)).toHaveLength(0);
  });

  it("文件上传失败仍继续后续文件；已登记副本损坏不读取原始文件重发", async () => {
    const f = sendFixture();
    for (const n of [2, 3]) writeFileSync(path.join(f.workdir, `${n}.txt`), "文件" + n);
    const original = f.call.getMockImplementation()!;
    f.call.mockImplementation(async (action, params) => {
      if (action === "upload_group_file" && params?.name === "2.txt") throw new Error("响应丢失");
      return original(action, params);
    });
    await f.service.send(f.binding, { text: "三个文件", files: [{ path: "file.txt" }, { path: "2.txt" }, { path: "3.txt" }] }, { callId: "files" });
    expect(f.service.rows(f.ticket)[0]!.files.map(file => file.status)).toEqual(["sent", "uncertain", "sent"]);
    const file = f.service.rows(f.ticket)[0]!.files[0]!;
    const row = f.store.reserveOutbox({ ticket: f.ticket, call_id: "recovery", message_type: "group", target_id: "7",
      mention_user_id: null, text: "恢复", images: [], files: [{ ...file, status: "pending", file_id: undefined }] });
    f.store.markOutboxSending(row.key); f.store.markOutboxSent(row.key, "old");
    writeFileSync(file.filename, "篡改");
    await f.service.reconcile(f.ticket);
    expect(f.store.getOutbox(row.key)!.files[0]!.status).toBe("uncertain");
    expect(f.call.mock.calls.filter(c => c[0].startsWith("upload"))).toHaveLength(3);
  });

  it("多条机器人图片消息可按各自回执召回，入站票据尚 pending 也不误拒绝", async () => {
    const f = sendFixture();
    for (const id of ["a", "b"]) await f.service.send(f.binding, { text: id, images: ["image.png"] }, { callId: id });
    f.bridge.fetchMessage = async id => ({ message_type: "group", message_id: id, group_id: "7", sender_id: "2",
      sender_conflict: false, recipient_fields: {}, has_nonempty_group_field: true, segments: [] });
    const recall = new MediaRecall({ dataDir: f.dir, store: f.history, channel: f.bridge });
    for (const row of f.service.rows(f.ticket)) await expect(recall.recall(f.binding.access, row.message_id!)).resolves.toBeDefined();
    f.bridge.fetchMessage = async id => ({ message_type: "group", message_id: id, group_id: "8", sender_id: "2",
      sender_conflict: false, recipient_fields: {}, has_nonempty_group_field: true, segments: [] });
    await expect(recall.recall(f.binding.access, f.service.rows(f.ticket)[0]!.message_id!)).rejects.toThrow("范围");
  });
});


it.each(["pi", "codex"] as const)("系统消息不占 %s 模型额度，重放不会映射到系统行", async backend => {
  const f = sendFixture();
  await f.service.system(f.ticket, "late", "系统迟到消息");
  const identity = (n: number, attempt: string) => backend === "pi" ? { callId: "call-" + n } : { attempt };
  for (const n of [1, 2, 3]) await f.service.send(f.binding, { text: "模型消息" + n }, identity(n, "first"));
  const rows = f.service.rows(f.ticket);
  expect(rows.map(row => row.key)).toEqual(["late", 1, 2, 3].map(suffix => f.ticket + "#" + suffix));
  expect(rows.map(row => row.ordinal)).toEqual([1, 2, 3, 4]);
  for (const n of [1, 2, 3]) expect(await f.service.send(f.binding, { text: "重放" }, identity(n, "retry")))
    .toMatchObject({ already_sent: true, message_id: rows[n]!.message_id });
  await expect(f.service.send(f.binding, { text: "超额" }, identity(4, "retry"))).rejects.toThrow("3 条");
  expect(f.call.mock.calls.filter(c => c[0] === "send_group_msg")).toHaveLength(4);
});


it.each(["sent", "uncertain"] as const)("新调用与 %s 行正文相同直接返回原行，不消耗额度或重新读取附件", async status => {
  const f = sendFixture();
  if (status === "uncertain") f.call.mockImplementationOnce(async () => ({ user_id: 2 })).mockRejectedValueOnce(new Error("响应丢失"));
  const first = await f.service.send(f.binding, { text: "同一内容" }, { callId: "first" });
  const repeat = await f.service.send(f.binding, { text: "同一内容", files: [{ path: "不存在.txt" }] }, { callId: "another" });
  expect(repeat).toMatchObject({ status, already_sent: true, message_id: first.message_id });
  if (status === "uncertain") expect(repeat.note).toContain("消息可能已送达，不要重发");
  for (const n of [2, 3]) await f.service.send(f.binding, { text: "内容" + n }, { callId: "call-" + n });
  expect(await f.service.send(f.binding, { text: "同一内容" }, { callId: "at-cap" })).toMatchObject({ already_sent: true });
  expect(f.service.rows(f.ticket)).toHaveLength(3);
  expect(f.call.mock.calls.filter(c => c[0] === "send_group_msg")).toHaveLength(3);
});

it("Codex 重跑的不同正文返回原文及说明；下一次调用按下一序号发送新内容", async () => {
  const f = sendFixture();
  await f.service.send(f.binding, { text: "旧内容" }, { attempt: "first" });
  expect(await f.service.send(f.binding, { text: "新内容" }, { attempt: "retry" })).toMatchObject({
    already_sent: true, original_text: "旧内容", note: expect.stringContaining("新内容未发送，如需发送请再调用一次"),
  });
  expect(f.service.rows(f.ticket)).toHaveLength(1);
  expect(await f.service.send(f.binding, { text: "新内容" }, { attempt: "retry" })).toMatchObject({ already_sent: false });
  expect(f.service.rows(f.ticket).map(row => row.text)).toEqual(["旧内容", "新内容"]);
});

it("重放、文本去重、reconcile 不重复记录 send_message；fallback 仅首次预留计数", async () => {
  const f = sendFixture(), stages: string[] = [];
  const untap = trace.tap(e => { if (e.ticket === f.ticket) stages.push(e.stage); });
  try {
    f.call.mockImplementationOnce(async () => ({ user_id: 99 }));
    await expect(f.service.system(f.ticket, "fallback", "兜底", [], undefined, true)).rejects.toThrow();
    await f.service.system(f.ticket, "fallback", "兜底", [], undefined, true);
    await f.service.system(f.ticket, "fallback", "兜底", [], undefined, true);
    await f.service.send(f.binding, { text: "兜底" }, { callId: "same" });
    await f.service.reconcile(f.ticket);
    expect(stages.filter(s => s === "send_message")).toHaveLength(1);
    expect(stages.filter(s => s === "no_send_fallback")).toHaveLength(1);
  } finally { untap(); }
});

it("settle 排在同票据发送及文件上传之后，随后清理完整副本目录", async () => {
  const f = sendFixture();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const original = f.call.getMockImplementation()!;
  f.call.mockImplementation(async (action, params) => { if (action.startsWith("upload_")) await gate; return original(action, params); });
  const send = f.service.send(f.binding, { text: "报告", images: ["image.png"], files: [{ path: "file.txt" }] }, { callId: "a" });
  await vi.waitFor(() => expect(f.call.mock.calls.some(c => c[0].startsWith("upload_"))).toBe(true));
  const settleCall = vi.spyOn(f.bridge, "settleTicket");
  const settle = f.service.settle(f.ticket);
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(settleCall).not.toHaveBeenCalled();
  release(); await send; await settle;
  const row = f.service.rows(f.ticket)[0]!;
  expect(row.files[0]!.status).toBe("sent");
  await f.service.cleanup(f.ticket);
  expect(existsSync(path.join(f.dir, "images", f.ticket, "outbox"))).toBe(false);
  expect(await f.service.send(f.binding, { text: "报告" }, { callId: "a" })).toMatchObject({ already_sent: true });
});

it("终态清理保留 pending/sending 文件行的全部副本，处理完后可再次清理", async () => {
  const f = sendFixture(), control = new AbortController();
  const original = f.bridge.send.bind(f.bridge);
  const send = vi.spyOn(f.bridge, "send").mockImplementation(async (...args) => {
    const result = await original(...args); control.abort(); return result;
  });
  await expect(f.service.send(f.binding, { text: "待上传", images: ["image.png"], files: [{ path: "file.txt" }] }, { callId: "pending" }, control.signal)).rejects.toThrow();
  send.mockRestore();
  await f.service.send(f.binding, { text: "已完成", images: ["image.png"] }, { callId: "done" });
  const [pending, done] = f.service.rows(f.ticket);
  await f.service.settle(f.ticket);
  await f.service.cleanup(f.ticket);
  expect(existsSync(pending!.files[0]!.filename)).toBe(true);
  expect(existsSync(pending!.images[0]!)).toBe(true);
  expect(existsSync(done!.images[0]!)).toBe(false);
  f.store.updateOutboxFile(pending!.key, 0, "sending");
  await f.service.cleanup(f.ticket);
  expect(existsSync(pending!.files[0]!.filename)).toBe(true);
  f.store.updateOutboxFile(pending!.key, 0, "uncertain");
  await f.service.cleanup(f.ticket);
  expect(existsSync(path.join(f.dir, "images", f.ticket, "outbox"))).toBe(false);
});
