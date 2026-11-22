import { env, reset } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Context } from "@earendil-works/chord/context";
import type { ToolExecutionApi, ToolRegistration } from "@earendil-works/pi-durable";
import { MediaTrace, mediaErrorDetail, type MediaDiagnostic } from "../src/media/diagnostics";
import { MediaDownloadError, downloadMedia } from "../src/media/download";
import { MediaRepository } from "../src/media/repository";
import { createMediaExtension, type MediaDeps } from "../src/tools/media";
import { lookupHostMedia, type MediaLookupBridge } from "../src/tools/media-host";
import { SANDBOX_FAILURES } from "../src/sandbox/client";
import { parseFrame } from "../src/onebot";
import type { InboundMedia } from "../src/policy";
import { action, connect } from "./helpers";

const sockets: WebSocket[] = [];
afterEach(async () => { for (const socket of sockets.splice(0)) socket.close(); vi.restoreAllMocks(); await reset(); });
const secret = "synthetic_private_cookie_and_token";
const url = "https://1.1.1.1/private?token=" + secret;
const source = { scope: "private:10000003", namespace: "private:10000003", target: { kind: "private" as const, userId: "10000003" } };
function fixture() {
  const logs: MediaDiagnostic[] = [];
  const repo = new MediaRepository({ bucket: env.ASSETS, scope: source.namespace });
  let items: InboundMedia[] = [{ kind: "file", ordinal: 1, fileId: "private-file-reference", name: "private-name.txt" }];
  const database = { get: vi.fn(async (sql: string) => sql.includes("message_media")
    ? (items.length ? { media_json: JSON.stringify(items), recalled: 0 } : undefined) : { message_id: "1" }) } as unknown as Parameters<typeof lookupHostMedia>[0]["database"];
  const rpc = {
    getMessage: vi.fn(async () => ({ message_id: "1", user_id: "10000003", message_type: "private", message: [{ type: "file", data: { url } }] })),
    getFileUrl: vi.fn<MediaLookupBridge["getFileUrl"]>(async () => url), getFile: vi.fn(async () => url), getRecord: vi.fn(async () => url),
    getImage: vi.fn<MediaLookupBridge["getImage"]>(),
  };
  const record = vi.fn(async (_kind: string, _detail: object) => {});
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(new Uint8Array([1, 2, 3])));
  const deps: MediaDeps = {
    allowed: async () => true, scope: async () => source.scope, repository: async () => repo,
    lookup: (messageId, _api, _context, selection, trace) => lookupHostMedia({ database, bridge: rpc, source, messageId, selection, trace }),
    sandbox: async () => { throw new Error("unused"); }, deliver: async () => {}, record, log: event => logs.push(event),
  };
  const run = async (args: { message_id: string; ordinal?: number } = { message_id: "1", ordinal: 1 }) => {
    const tool: ToolRegistration = createMediaExtension(deps).tools!.find(tool => tool.name === "qq_attachment")!;
    return tool.execute(args, {} as ToolExecutionApi, {} as Context);
  };
  return { logs, repo, rpc, database, record, fetcher, deps, run, setItems: (next: InboundMedia[]) => { items = next; } };
}

describe("附件阶段诊断", () => {
  it("同一trace贯穿解析下载存储审计，成功资产不因审计失败而丢失", async () => {
    const f = fixture(), put = vi.spyOn(f.repo, "put");
    f.record.mockRejectedValue(new Error("audit " + secret));
    const result = await f.run();
    expect(result.isError).not.toBe(true);
    expect(put).toHaveBeenCalledTimes(1);
    expect(f.record).toHaveBeenCalledTimes(1);
    const identity = f.logs.find(row => row.stage === "store")!;
    expect(identity).toMatchObject({ message_id: "1", ordinal: 1, scope: source.scope });
    expect(identity.traceId).toMatch(/^[a-f0-9-]{36}$/);
    expect(new Set(f.logs.map(row => row.traceId)).size).toBe(1);
    for (const stage of ["lookup", "metadata", "resolve_url", "get_private_file_url", "download", "store"]) {
      expect(f.logs.filter(row => row.stage === stage).map(row => row.state)).toEqual(["start", "success"]);
    }
    expect(f.logs.filter(row => row.stage === "audit").map(row => row.state)).toEqual(["start", "failure"]);
    expect(f.record.mock.calls[0]?.[1]).toMatchObject({ traceId: identity.traceId, message_id: "1", scope: source.scope, result: "ok" });
    const serialized = JSON.stringify(f.logs);
    for (const value of [secret, url, "private-file-reference", "private-name.txt"]) expect(serialized).not.toContain(value);
    expect(f.logs.every(row => Number.isInteger(row.ms) && row.ms >= 0 && row.ms <= 86_400_000)).toBe(true);
    const payload = result.output?.find(part => part.type === "text");
    if (payload?.type !== "text") throw new Error("missing_ref");
    const ref = JSON.parse(payload.text) as { id: string };
    expect((await f.repo.get(ref.id)).bytes).toEqual(new Uint8Array([1, 2, 3]));
  });

  it.each([
    ["lookup", "media_unexpected_error"], ["metadata", "media_unexpected_error"], ["get_msg", "onebot_failed"],
    ["resolve_url", "media_reference_missing"], ["get_private_file_url", "onebot_failed"],
    ["get_file", "onebot_timeout"], ["download", "media_type_error"], ["store", "media_unexpected_error"],
  ])("故障注入定位%s，保留错误码且审计失败不覆盖业务失败", async (stage, code) => {
    const f = fixture();
    const native = new Error("sensitive " + url + " cookie=" + secret);
    if (stage === "lookup") f.deps.lookup = async () => { throw native; };
    if (stage === "metadata") vi.spyOn(f.database, "get").mockRejectedValue(native);
    if (stage === "get_msg") { f.setItems([]); f.rpc.getMessage.mockRejectedValue(new Error("onebot_failed: " + secret)); }
    if (stage === "resolve_url") f.setItems([{ kind: "file", ordinal: 1 }]);
    if (stage === "get_private_file_url") f.rpc.getFileUrl.mockRejectedValue(new Error("onebot_failed:retcode=1200"));
    if (stage === "get_file") { f.setItems([{ kind: "file", ordinal: 1, file: "opaque-file" }]); f.rpc.getFile.mockRejectedValue(new Error("onebot_timeout: " + secret)); }
    if (stage === "download") f.fetcher.mockRejectedValue(new TypeError(url));
    if (stage === "store") vi.spyOn(f.repo, "put").mockRejectedValue(native);
    f.record.mockRejectedValue(new Error("secondary " + secret));
    const result = await f.run();
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.output)).toContain(code + "：");
    expect(f.logs.find(row => row.stage === stage && row.state === "failure")).toMatchObject({ code });
    expect(f.record.mock.calls[0]?.[1]).toMatchObject({ result: code, failedStage: stage });
    expect(f.record).toHaveBeenCalledTimes(1);
    const traceId = f.logs[0]!.traceId;
    expect(JSON.stringify(result.output)).toContain(traceId);
    expect(f.logs.every(row => row.traceId === traceId)).toBe(true);
    expect(JSON.stringify([f.logs, f.record.mock.calls, result.output])).not.toContain(secret);
    expect(JSON.stringify(f.logs)).not.toContain("https://");
  });

  it("get_msg回退与按ordinal选择均可追踪，另一回合不会复用trace", async () => {
    const f = fixture();
    f.setItems([]);
    await f.run();
    expect(f.logs.some(row => row.stage === "get_msg" && row.state === "success")).toBe(true);
    const first = f.logs[0]!.traceId;
    f.logs.length = 0;
    f.setItems([{ kind: "file", ordinal: 1, fileId: "do-not-read" }, { kind: "file", ordinal: 2, file: "second" }]);
    f.rpc.getFile.mockRejectedValue(new Error("onebot_disconnected"));
    await f.run({ message_id: "1", ordinal: 2 });
    expect(f.logs[0]!.traceId).not.toBe(first);
    expect(f.rpc.getFileUrl).not.toHaveBeenCalled();
    expect(f.logs.find(row => row.stage === "get_file" && row.state === "failure")).toMatchObject({ ordinal: 2, code: "onebot_disconnected" });
  });

  it("无附件与权限拒绝不是成功审计，拒绝时不访问附件", async () => {
    const f = fixture();
    f.deps.lookup = vi.fn(async () => []);
    expect((await f.run()).isError).toBe(true);
    expect(f.record.mock.calls[0]?.[1]).toMatchObject({ result: "media_not_found" });
    f.deps.allowed = async () => false;
    expect((await f.run()).isError).toBe(true);
    expect(f.deps.lookup).toHaveBeenCalledTimes(1);
    expect(f.fetcher).not.toHaveBeenCalled();
  });
});

describe("错误结构与原始异常", () => {
  it("仅允许稳定错误码和有界数值，原始异常与日志sink失败互不污染", async () => {
    const error = new TypeError(url), logs: MediaDiagnostic[] = [], trace = new MediaTrace({ messageId: "upload:" + url, ordinal: 999 }, row => logs.push(row));
    trace.setScope("owner?" + secret);
    await expect(trace.run("lookup", () => trace.run("get_msg", async () => { throw error; }))).rejects.toBe(error);
    expect(trace.summary()).toMatchObject({ failedStage: "get_msg", message_id: "redacted", scope: "redacted" });
    expect(JSON.stringify(logs)).not.toContain(secret);
    expect(logs.every(row => row.ordinal === undefined)).toBe(true);
    const brokenSink = new MediaTrace({}, () => { throw new Error(secret); });
    expect(await brokenSink.run("store", async () => 42)).toBe(42);
    await expect(brokenSink.run("store", async () => { throw error; })).rejects.toBe(error);
    for (const code of SANDBOX_FAILURES) expect(mediaErrorDetail(new Error(code)).code).toBe(code);
    expect(mediaErrorDetail(new Error(secret))).toMatchObject({ code: "media_unexpected_error" });
    expect(mediaErrorDetail(new SyntaxError(secret)).code).toBe("media_invalid_json");
    expect(mediaErrorDetail(new DOMException(secret, "AbortError")).code).toBe("media_aborted");
    expect(mediaErrorDetail(new DOMException(secret, "TimeoutError")).code).toBe("media_timeout");
    expect(mediaErrorDetail({ token: secret }).code).toBe("media_unknown_error");
    expect(mediaErrorDetail(new MediaDownloadError(403, secret))).toEqual({ code: "media_download_failed", errorType: "MediaDownloadError", status: 403 });
    expect(mediaErrorDetail(new Error("onebot_failed:retcode=-1")).retcode).toBe(-1);
    expect(mediaErrorDetail(new Error("onebot_failed:retcode=99999999999")).retcode).toBeUndefined();
  });

  it("下载阶段保留HTTP状态、超时和原始读取流异常，不泄露URL", async () => {
    const logs: MediaDiagnostic[] = [], trace = new MediaTrace({ messageId: "1" }, row => logs.push(row));
    await expect(downloadMedia(url, { trace, fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 403 })) })).rejects.toBeInstanceOf(MediaDownloadError);
    expect(logs.at(-1)).toMatchObject({ stage: "download", state: "failure", code: "media_download_failed", status: 403 });
    const timeout = new DOMException(secret, "TimeoutError");
    await expect(downloadMedia(url, { trace, signal: AbortSignal.abort(timeout) })).rejects.toBe(timeout);
    expect(logs.at(-1)).toMatchObject({ code: "media_timeout" });
    const original = new Error(url);
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.error(original); } });
    await expect(downloadMedia(url, { trace, fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response(body)) })).rejects.toBe(original);
    expect(JSON.stringify(logs)).not.toContain(secret);
  });
});

it("真实OneBot拒绝仅传递有界retcode，宿主trace不依赖RPC自定义异常字段", async () => {
  const f = fixture(), { socket, frames } = await connect(sockets);
  f.deps.lookup = (messageId, _api, _context, selection, trace) => lookupHostMedia({ database: f.database, bridge: env.BRIDGE.getByName("napcat"), source, messageId, selection, trace });
  const pending = f.run();
  const request = await action(frames, 0, "get_private_file_url");
  socket.send(JSON.stringify({ status: "failed", retcode: 1200, echo: request.echo, wording: secret, data: { url } }));
  const result = await pending;
  expect(result.isError).toBe(true);
  expect(f.logs.find(row => row.stage === "get_private_file_url" && row.state === "failure")).toMatchObject({ code: "onebot_failed", retcode: 1200 });
  expect(JSON.stringify([f.logs, result.output])).not.toContain(secret);
  expect(parseFrame(JSON.stringify({ echo: "x", status: "failed", retcode: secret }))).not.toHaveProperty("retcode");
});

it("已有资产读取可追踪且不重新下载，损坏资产保留稳定错误码", async () => {
  const f = fixture(), asset = await f.repo.put({ bytes: new Uint8Array([1]), name: "cached", kind: "file" });
  f.setItems([{ kind: "file", ordinal: 1, assetId: asset.id }]);
  expect((await f.run()).isError).not.toBe(true);
  expect(f.fetcher).not.toHaveBeenCalled();
  expect(f.logs.some(row => row.stage === "asset_get" && row.state === "success")).toBe(true);
  expect(f.logs.some(row => row.stage === "download" || row.stage === "store")).toBe(false);
  vi.spyOn(f.repo, "get").mockRejectedValue(new Error("asset_corrupt"));
  expect((await f.run()).isError).toBe(true);
  expect(f.record.mock.calls.at(-1)?.[1]).toMatchObject({ result: "asset_corrupt", failedStage: "asset_get" });
});

it("未指定ordinal时并行解析的失败仍关联正确附件", async () => {
  const f = fixture();
  f.setItems([{ kind: "file", ordinal: 1, fileId: "first" }, { kind: "file", ordinal: 2, fileId: "second" }]);
  f.rpc.getFileUrl.mockImplementation(async (_target, fileId) => { if (fileId === "second") throw new Error("onebot_failed"); return url; });
  const result = await f.run({ message_id: "1" });
  expect(result.isError).toBe(true);
  expect(f.record.mock.calls[0]?.[1]).toMatchObject({ ordinal: 2, failedStage: "get_private_file_url" });
  expect(f.logs.filter(row => row.stage === "get_private_file_url" && row.state === "start").map(row => row.ordinal)).toEqual([1, 2]);
});

it("明确大小限制错误不被通用提示反向否认", async () => {
  const f = fixture();
  f.fetcher.mockResolvedValue(new Response(new Uint8Array([1]), { headers: { "content-length": "11000000" } }));
  const result = await f.run();
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result.output)).toContain("too_large");
  expect(JSON.stringify(result.output)).not.toContain("不能据此认定");
});
