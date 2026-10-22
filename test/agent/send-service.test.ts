import { existsSync, readFileSync, writeFileSync, mkdirSync, symlinkSync, utimesSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SendService } from "../../src/agent/send-service.js";
import { sendFixture } from "./send-fixture.js";
import { trace } from "../../src/shared/trace.js";
import { MediaRecall } from "../../src/context/media.js";

const groupSends = (f: ReturnType<typeof sendFixture>) => f.call.mock.calls.filter(([a]) => a === "send_group_msg");
const rows = (f: ReturnType<typeof sendFixture>, turnId = "t1") => f.store.listOutboxByTurn(turnId);

describe("Outbox 与会话绑定的发送（§7）", () => {
  it("同一调用键重放返回原回执；行键 <会话>:<调用键>；本轮只有首条 @，引用命中每条真实消息", async () => {
    const f = sendFixture();
    const first = await f.service.send(f.binding, { text: "第一条", images: ["image.png"] }, "call-1");
    expect(await f.service.send(f.binding, { text: "重放措辞" }, "call-1")).toMatchObject({ message_id: first.message_id, already_sent: true });
    await Promise.all([2, 3].map(i => f.service.send(f.binding, { text: "消息" + i }, "call-" + i)));
    const messages = groupSends(f);
    expect(messages).toHaveLength(3);
    expect((messages[0]![1]!.message as { type: string }[]).map(m => m.type)).toEqual(["at", "text", "image"]);
    expect((messages[1]![1]!.message as { type: string }[]).map(m => m.type)).toEqual(["text"]);
    expect(rows(f).map(r => r.key).sort()).toEqual(["group:7:call-1", "group:7:call-2", "group:7:call-3"]);
    for (const row of rows(f)) {
      const hit = f.history.message(f.binding.access, row.message_id!)!.row;
      expect(hit.text).toBe(row.text);
      expect(hit.reply_to_id).toBe("11");
    }
  });

  it("回合结束后仍可发送（不再有\"本回合已经结束\"），也没有每轮条数上限", async () => {
    const f = sendFixture();
    for (let i = 0; i < 5; i++) await f.service.send(f.binding, { text: "第" + i + "条" }, "c" + i);
    // 唤醒回合（无新输入）发往本会话
    await f.service.send(f.bindingFor({ kind: "wake" }, "t2"), { text: "子 agent 结果" }, "wake-1");
    expect(groupSends(f)).toHaveLength(6);
    // 唤醒回合不 @
    expect(f.store.getOutbox("group:7:wake-1")!.mention_user_id).toBeNull();
  });

  it.each(["sending", "uncertain"] as const)("%s 行不重发", async status => {
    const f = sendFixture();
    const row = f.store.reserveOutbox({ key: "group:7:stable", thread_key: "group:7", turn_id: "t1", input_key: f.key, text: "先前消息", images: [], files: [],
      message_type: "group", target_id: "7", mention_user_id: "1" });
    f.store.markOutboxSending(row.key);
    if (status === "uncertain") f.store.markOutboxUncertain(row.key);
    await expect(f.service.send(f.binding, { text: "再试" }, "stable")).resolves.toMatchObject({ status, note: expect.stringContaining("不要重发") });
    expect(f.call).not.toHaveBeenCalled();
  });

  it("发送失败后为 uncertain；登录校验失败仍 pending，可安全重试", async () => {
    const f = sendFixture();
    f.call.mockImplementationOnce(async () => ({ user_id: 99 }));
    await expect(f.service.send(f.binding, { text: "正文" }, "a")).rejects.toThrow("登录账号");
    expect(f.store.getOutbox("group:7:a")!.status).toBe("pending");
    f.call.mockImplementationOnce(async () => ({ user_id: 2 })).mockRejectedValueOnce(new Error("network"));
    await expect(f.service.send(f.binding, { text: "正文" }, "a")).resolves.toMatchObject({ status: "uncertain", note: expect.stringContaining("不要重发") });
    expect(f.store.getOutbox("group:7:a")!.status).toBe("uncertain");
    expect(f.store.markOutboxSending("group:7:a")).toBe(false);
  });

  it("正文先发，文件各自落盘；恢复 pending 上传、sending 转 uncertain，不重复上传", async () => {
    const f = sendFixture();
    await f.service.send(f.binding, { text: "报告", files: [{ path: "file.txt", name: "报告.txt" }] }, "f");
    expect(f.call.mock.calls.map(c => c[0])).toEqual(["get_login_info", "send_group_msg", "upload_group_file"]);
    expect(f.store.getOutbox("group:7:f")!.files[0]).toMatchObject({ status: "sent", file_id: "file-2", name: "报告.txt" });
    await f.service.send(f.binding, { text: "报告" }, "f");
    expect(f.call.mock.calls.filter(c => c[0].startsWith("upload"))).toHaveLength(1);
    const file = f.store.getOutbox("group:7:f")!.files[0]!;
    const raw = f.store.reserveOutbox({ key: "group:7:crash", thread_key: "group:7", turn_id: "t1", input_key: f.key, text: "恢复", images: [],
      message_type: "group", target_id: "7", mention_user_id: null,
      files: [file, file].map(x => ({ ...x, status: "pending" as const, file_id: undefined })) });
    f.store.markOutboxSending(raw.key); f.store.markOutboxSent(raw.key, "old");
    f.store.updateOutboxFile(raw.key, 0, "sending");
    expect(f.store.listUnfinishedOutbox().map(r => r.key)).toEqual([raw.key]);
    await f.service.reconcile();
    expect(f.store.getOutbox(raw.key)!.files.map(x => x.status)).toEqual(["uncertain", "sent"]);
    expect(f.call.mock.calls.filter(c => c[0].startsWith("upload"))).toHaveLength(2);
    expect(f.store.listUnfinishedOutbox()).toEqual([]);
  });

  it.each([
    { text: "" }, { text: "x".repeat(4001) }, { text: "正文", images: Array(5).fill("image.png") },
    { text: "正文", files: Array(4).fill({ path: "file.txt" }) }, { text: "正文", target: "group:8" },
    { text: "正文", images: ["../secret.png"] }, { text: "正文", files: [{ path: "bad.exe" }] },
  ])("校验失败不建行、不截断：%j", async args => {
    const f = sendFixture();
    writeFileSync(path.join(f.workdir, "bad.exe"), "blocked");
    await expect(f.service.send(f.binding, args, "bad")).rejects.toThrow();
    expect(f.store.getOutbox("group:7:bad")).toBeNull(); expect(f.call).not.toHaveBeenCalled();
  });

  it("调用键只接受安全字符，不能伪造系统行", async () => {
    const f = sendFixture();
    for (const key of ["", "sys:x", "a b", "x".repeat(201)]) await expect(f.service.send(f.binding, { text: "正文" }, key)).rejects.toThrow("稳定调用 id");
    expect(f.call).not.toHaveBeenCalled();
  });

  it("文件上限、目录、跨工作区与软链接不扩大来源权限", async () => {
    const f = sendFixture();
    writeFileSync(path.join(f.workdir, "large.txt"), Buffer.alloc(20 * 1024 * 1024 + 1));
    mkdirSync(path.join(f.workdir, "folder"));
    symlinkSync(f.workdir, path.join(f.workdir, "link"), "junction");
    for (const file of ["large.txt", "folder", "link/file.txt", "../qq-bridge.sqlite"]) {
      await expect(f.service.send(f.binding, { text: "文件", files: [{ path: file }] }, "k" + file.length)).rejects.toThrow();
    }
    expect(rows(f)).toHaveLength(0);
  });

  it("文件上传失败仍继续后续文件；已登记副本损坏不读取原始文件重发", async () => {
    const f = sendFixture();
    for (const n of [2, 3]) writeFileSync(path.join(f.workdir, `${n}.txt`), "文件" + n);
    const original = f.call.getMockImplementation()!;
    f.call.mockImplementation(async (action, params) => {
      if (action === "upload_group_file" && params?.name === "2.txt") throw new Error("响应丢失");
      return original(action, params);
    });
    await f.service.send(f.binding, { text: "三个文件", files: [{ path: "file.txt" }, { path: "2.txt" }, { path: "3.txt" }] }, "files");
    expect(f.store.getOutbox("group:7:files")!.files.map(file => file.status)).toEqual(["sent", "uncertain", "sent"]);
    const file = f.store.getOutbox("group:7:files")!.files[0]!;
    const row = f.store.reserveOutbox({ key: "group:7:recovery", thread_key: "group:7", turn_id: "t1", input_key: f.key, message_type: "group", target_id: "7",
      mention_user_id: null, text: "恢复", images: [], files: [{ ...file, status: "pending", file_id: undefined }] });
    f.store.markOutboxSending(row.key); f.store.markOutboxSent(row.key, "old");
    writeFileSync(file.filename, "篡改");
    await f.service.reconcile();
    expect(f.store.getOutbox(row.key)!.files[0]!.status).toBe("uncertain");
    expect(f.call.mock.calls.filter(c => c[0].startsWith("upload"))).toHaveLength(3);
  });

  it("多条机器人图片消息按 Outbox 行召回；发往别处的消息不能以本群召回", async () => {
    const f = sendFixture();
    for (const id of ["a", "b"]) await f.service.send(f.binding, { text: id, images: ["image.png"] }, id);
    f.bridge.fetchMessage = async id => ({ message_type: "group", message_id: id, group_id: "7", sender_id: "2",
      sender_conflict: false, recipient_fields: {}, has_nonempty_group_field: true, segments: [] });
    const recall = new MediaRecall({ dataDir: f.dir, store: f.history, channel: f.bridge });
    for (const row of rows(f)) await expect(recall.recall(f.binding.access, row.message_id!)).resolves.toBeDefined();
    f.bridge.fetchMessage = async id => ({ message_type: "group", message_id: id, group_id: "8", sender_id: "2",
      sender_conflict: false, recipient_fields: {}, has_nonempty_group_field: true, segments: [] });
    await expect(recall.recall(f.binding.access, rows(f)[0]!.message_id!)).rejects.toThrow("范围");
  });
});

it("系统消息键为 <会话>:sys:<uuid>，不 @、不占主动额度、不能被模型调用键映射", async () => {
  const f = sendFixture();
  const result = await f.service.system(f.binding, "这次处理出错了，需要的话请再说一次。");
  const [sys] = rows(f);
  expect(sys!.key).toMatch(/^group:7:sys:[0-9a-f-]{36}$/);
  expect(sys).toMatchObject({ system: true, mention_user_id: null, proactive: false, status: "sent" });
  expect(result.message_id).toBe(sys!.message_id);
  await f.service.send(f.binding, { text: "模型消息" }, "call-1");
  expect(groupSends(f)).toHaveLength(2);
  // 模型的首条消息仍 @ 发送者（系统消息不消耗 @）
  expect((groupSends(f)[1]![1]!.message as { type: string }[])[0]!.type).toBe("at");
});

it.each(["sent", "uncertain"] as const)("同一回合内新调用与 %s 行正文相同直接返回原行；别的回合照常发送", async status => {
  const f = sendFixture();
  if (status === "uncertain") f.call.mockImplementationOnce(async () => ({ user_id: 2 })).mockRejectedValueOnce(new Error("响应丢失"));
  const first = await f.service.send(f.binding, { text: "同一内容" }, "first");
  const repeat = await f.service.send(f.binding, { text: "同一内容" }, "another");
  expect(repeat).toMatchObject({ status, already_sent: true, message_id: first.message_id });
  if (status === "uncertain") expect(repeat.note).toContain("消息可能已送达，不要重发");
  expect(rows(f)).toHaveLength(1);
  expect(await f.service.send(f.bindingFor(undefined, "t2"), { text: "同一内容" }, "next-turn")).toMatchObject({ already_sent: false });
});

it("同一回合正文相同但图片或文件不同：照常发送新附件；附件内容相同才视为重复", async () => {
  const f = sendFixture();
  writeFileSync(path.join(f.workdir, "other.png"), Buffer.concat([readFileSync(path.join(f.workdir, "image.png")), Buffer.from([0])]));
  const first = await f.service.send(f.binding, { text: "看图", images: ["image.png"] }, "first");
  const otherImage = await f.service.send(f.binding, { text: "看图", images: ["other.png"] }, "second");
  expect(otherImage).toMatchObject({ already_sent: false });
  expect(otherImage.message_id).not.toBe(first.message_id);
  const withFile = await f.service.send(f.binding, { text: "看图", images: ["image.png"], files: [{ path: "file.txt" }] }, "third");
  expect(withFile).toMatchObject({ already_sent: false });
  // 同一图片内容（不同路径）且没有文件：与第一条重复
  writeFileSync(path.join(f.workdir, "copy.png"), readFileSync(path.join(f.workdir, "image.png")));
  expect(await f.service.send(f.binding, { text: "看图", images: ["copy.png"] }, "fourth")).toMatchObject({ already_sent: true, message_id: first.message_id });
  expect(groupSends(f)).toHaveLength(3);
  expect(rows(f).find(r => r.key === "group:7:third")!.files).toMatchObject([{ status: "sent" }]);
});

it("重放与 reconcile 不重复记录 send_message；观测按回合键", async () => {
  const f = sendFixture(), stages: string[] = [];
  const untap = trace.tap(e => { if (e.key === "turn:t1") stages.push(e.stage); });
  try {
    await f.service.send(f.binding, { text: "一次" }, "same");
    await f.service.send(f.binding, { text: "一次" }, "same");
    await f.service.reconcile();
    expect(stages.filter(s => s === "send_message")).toHaveLength(1);
  } finally { untap(); }
});

it("同一会话串行：文件上传结束前，同会话的下一条发送等待", async () => {
  const f = sendFixture();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const original = f.call.getMockImplementation()!;
  f.call.mockImplementation(async (action, params) => { if (action.startsWith("upload_")) await gate; return original(action, params); });
  const send = f.service.send(f.binding, { text: "报告", images: ["image.png"], files: [{ path: "file.txt" }] }, "a");
  await vi.waitFor(() => expect(f.call.mock.calls.some(c => c[0].startsWith("upload_"))).toBe(true));
  const next = f.service.send(f.binding, { text: "下一条" }, "b");
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(groupSends(f)).toHaveLength(1);
  release(); await send; await next;
  expect(groupSends(f)).toHaveLength(2);
});

it("清理只删除一小时前的副本，保留 pending/sending 文件行的副本", async () => {
  const f = sendFixture(), control = new AbortController();
  const original = f.bridge.send.bind(f.bridge);
  const send = vi.spyOn(f.bridge, "send").mockImplementation(async (...args) => {
    const result = await original(...args); control.abort(); return result;
  });
  await expect(f.service.send(f.binding, { text: "待上传", images: ["image.png"], files: [{ path: "file.txt" }] }, "pending", control.signal)).rejects.toThrow();
  send.mockRestore();
  await f.service.send(f.binding, { text: "已完成", images: ["image.png"] }, "done");
  const pending = f.store.getOutbox("group:7:pending")!, done = f.store.getOutbox("group:7:done")!;
  await f.service.cleanup("group:7");
  expect(existsSync(done.images[0]!)).toBe(true);
  const old = new Date(Date.now() - 2 * 3_600_000);
  for (const file of [pending.images[0]!, done.images[0]!]) utimesSync(path.dirname(file), old, old);
  await f.service.cleanup("group:7");
  expect(existsSync(pending.files[0]!.filename)).toBe(true);
  expect(existsSync(pending.images[0]!)).toBe(true);
  expect(existsSync(done.images[0]!)).toBe(false);
  f.store.updateOutboxFile(pending.key, 0, "sending");
  f.store.updateOutboxFile(pending.key, 0, "uncertain");
  await f.service.cleanup("group:7");
  expect(existsSync(path.join(f.dir, "images", "group_7", "outbox"))).toBe(false);
});

it("重建网关后同一调用键仍映射原行", async () => {
  const f = sendFixture(false);
  const a = await f.service.send(f.binding, { text: "原文" }, "turn#1");
  const recovered = new SendService({ getChannel: () => f.bridge, dataDir: f.dir });
  expect(await recovered.send(f.binding, { text: "改变措辞" }, "turn#1")).toMatchObject({ already_sent: true, message_id: a.message_id });
});
