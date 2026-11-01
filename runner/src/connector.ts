import { promises as fs } from "node:fs";
import path from "node:path";
import { WebSocket } from "ws";
import { Type } from "typebox";
import { parse, parseFrame, ServerFrameSchema, JobInputSchema, OutcomeSchema, PROTOCOL_VERSION, MAX_CONTROL_BYTES, validateDescriptor, validateOutcome, type DeviceFrame, type Outcome } from "./protocol.ts";
import { atomicJson, exists, readJson } from "./files.ts";
import { descriptor, protectToken, type Config, WsbBackend } from "./wsb.ts";

const JournalSchema = Type.Union([
  Type.Object({ state: Type.Literal("acknowledged") }, { additionalProperties: false }),
  Type.Object({ state: Type.Literal("started") }, { additionalProperties: false }),
  Type.Object({ state: Type.Literal("finished"), outcome: OutcomeSchema }, { additionalProperties: false }),
]);
export function origin(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
    url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new Error("https_origin_required");
  return url.origin;
}
export async function request(base: string, token: string | undefined, pathname: string, init: RequestInit = {}, limit = MAX_CONTROL_BYTES) {
  const response = await fetch(origin(base) + pathname, { ...init, redirect: "error", signal: AbortSignal.timeout(60000),
    headers: { ...(token ? { Authorization: "Bearer " + token } : {}), ...init.headers } });
  if (!response.ok) throw new Error("http_" + response.status);
  const reader = response.body?.getReader(), chunks: Uint8Array[] = []; let size = 0;
  if (reader) for (;;) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.length; if (size > limit) { await reader.cancel(); throw new Error("response_too_large"); } chunks.push(chunk.value); }
  return Buffer.concat(chunks);
}
export class Connector {
  readonly state: string;
  readonly config: Config;
  readonly backend: Pick<WsbBackend, "run" | "stopOwned" | "release">;
  private readonly credentials: () => Promise<string>;
  private readonly capabilities: () => Promise<import("./protocol.ts").Descriptor>;
  private socket?: WebSocket;
  private active?: { id: string; abort: AbortController; promise: Promise<void> };
  private releasing?: Promise<void>;
  private stopping = false;
  private token = "";
  constructor(state: string, config: Config, bundleDir: string, adapters?: {
    backend: Pick<WsbBackend, "run" | "stopOwned" | "release">; credentials(): Promise<string>; capabilities(): Promise<import("./protocol.ts").Descriptor>;
  }) {
    this.state = path.resolve(state); this.config = config; this.backend = adapters?.backend ?? new WsbBackend(this.state, config, bundleDir);
    this.credentials = adapters?.credentials ?? (() => protectToken(config.tokenProtected, true));
    this.capabilities = adapters?.capabilities ?? (() => descriptor(config));
  }
  private prefix(id: string) { return "/sandbox-devices/" + this.config.deviceId + "/jobs/" + id; }
  private send(frame: DeviceFrame) { if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(frame)); }
  private async post(id: string, outcome: Outcome) {
    validateOutcome(outcome);
    await request(this.config.origin, this.token, this.prefix(id) + "/result", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(outcome) }, 65536);
  }
  private async execute(id: string, abort: AbortController) {
    const directory = path.join(this.state, "jobs", id), journalFile = path.join(directory, "journal.json");
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("invalid_job_id");
    if (await exists(journalFile)) {
      const journal = parse(JournalSchema, await readJson(journalFile));
      if (journal.state === "acknowledged") return;
      if (journal.state === "finished") { await this.post(id, journal.outcome); return; }
      await this.backend.stopOwned();
      const outcome: Outcome = { kind: "unknown", reason: "connector_restarted_after_dispatch", sessionLost: true };
      await atomicJson(journalFile, { state: "finished", outcome }); await this.post(id, outcome); return;
    }
    const input = parse(JobInputSchema, JSON.parse((await request(this.config.origin, this.token, this.prefix(id) + "/input")).toString("utf8")));
    if (input.id !== id || input.lease.deviceId !== this.config.deviceId) throw new Error("job_scope_mismatch");
    await atomicJson(path.join(directory, "input.json"), input);
    // 在任何 guest 执行之前持久化；重连只能回传结果，不重跑命令。
    await atomicJson(journalFile, { state: "started" });
    this.send({ kind: "accepted", jobId: id });
    let sequence = 0, outcome: Outcome;
    try { outcome = validateOutcome(await this.backend.run(input, abort.signal, text => this.send({ kind: "progress", jobId: id, sequence: sequence++, text }))); }
    catch {
      await this.backend.stopOwned();
      outcome = { kind: "unknown", reason: "sandbox_execution_unconfirmed", sessionLost: true };
    }
    await atomicJson(journalFile, { state: "finished", outcome });
    await this.post(id, outcome);
  }
  private start(id: string) {
    if (this.active?.id === id) { this.send({ kind: "accepted", jobId: id }); return; }
    if (this.active || this.releasing) throw new Error("local_slot_busy");
    const abort = new AbortController();
    const promise = this.execute(id, abort).catch(error => {
      console.error("任务回传未完成，等待重连重试：", error instanceof Error ? error.message : "runner_error"); this.socket?.close(1011, "retry_result");
    }).finally(() => { if (this.active?.id === id) this.active = undefined; });
    this.active = { id, abort, promise };
  }
  private async cancel(id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("invalid_job_id");
    if (this.active?.id === id) { this.active.abort.abort(); await this.active.promise; return; }
    if (this.active) throw new Error("local_slot_busy");
    const journalFile = path.join(this.state, "jobs", id, "journal.json");
    if (await exists(journalFile)) {
      const journal = parse(JournalSchema, await readJson(journalFile));
      if (journal.state === "acknowledged") return;
      if (journal.state === "finished" && journal.outcome.kind !== "unknown") { await this.post(id, journal.outcome); return; }
    }
    await this.backend.stopOwned();
    const outcome: Outcome = { kind: "cancelled", reason: "instance_stop_confirmed_result_not_replayed", sessionLost: true };
    await atomicJson(journalFile, { state: "finished", outcome }); await this.post(id, outcome);
  }
  private async acknowledge(id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("invalid_job_id");
    const directory = path.join(this.state, "jobs", id), journalFile = path.join(directory, "journal.json");
    const journal = parse(JournalSchema, await readJson(journalFile));
    if (journal.state !== "finished" || journal.outcome.kind === "unknown") return;
    await atomicJson(journalFile, { state: "acknowledged" });
    // 保留去重收据；任务文件只含参数与租约，不含连接凭据。
    await fs.rm(path.join(directory, "input.json"), { force: true });
  }
  private release(leaseId: string) {
    if (this.releasing) return this.releasing;
    this.active?.abort.abort();
    this.releasing = (async () => {
      await this.active?.promise;
      await this.backend.release(leaseId);
      this.send({ kind: "released", leaseId });
    })().finally(() => { this.releasing = undefined; });
    return this.releasing;
  }
  async stop() { this.stopping = true; this.active?.abort.abort(); this.socket?.close(); await this.active?.promise; await this.releasing?.catch(() => undefined); await this.backend.stopOwned(); }
  async run() {
    this.token = await this.credentials();
    const capabilities = validateDescriptor(await this.capabilities());
    while (!this.stopping) {
      await new Promise<void>(resolve => {
        const url = new URL(origin(this.config.origin) + "/sandbox-devices/" + this.config.deviceId + "/connect");
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        const socket = new WebSocket(url, { headers: { Authorization: "Bearer " + this.token }, maxPayload: MAX_CONTROL_BYTES, handshakeTimeout: 15000, followRedirects: false });
        this.socket = socket;
        let lastPong = Date.now();
        const timer = setInterval(() => {
          if (Date.now() - lastPong > 45000) { this.active?.abort.abort(); socket.terminate(); }
          else if (socket.readyState === WebSocket.OPEN) socket.send("ping");
        }, 15000);
        socket.on("open", () => { console.log("连接已建立，正在注册沙箱工具。"); this.send({ kind: "hello", protocolVersion: PROTOCOL_VERSION, descriptor: capabilities }); });
        socket.on("message", data => {
          const raw = data.toString(); if (raw === "pong") { lastPong = Date.now(); return; }
          let frame;
          try { frame = parseFrame(ServerFrameSchema, raw); } catch { socket.close(1008, "invalid_frame"); return; }
          switch (frame.kind) {
            case "welcome": if (frame.deviceId !== this.config.deviceId) socket.close(1008, "device_mismatch"); else console.log("设备已上线：", frame.deviceId); break;
            case "execute": try { this.start(frame.jobId); } catch { socket.close(1011, "local_slot_busy"); } break;
            case "cancel": void this.cancel(frame.jobId).catch(() => socket.close(1011, "cancel_failed")); break;
            case "release": void this.release(frame.leaseId).catch(() => socket.close(1011, "release_failed")); break;
            case "outcome_ack": void this.acknowledge(frame.jobId).catch(() => undefined); break;
            case "error": console.error("Worker 拒绝请求：", frame.error); socket.close(1008, "protocol_rejected"); break;
            default: { const exhaustive: never = frame; throw new Error(String(exhaustive)); }
          }
        });
        socket.on("error", () => undefined);
        socket.on("close", () => {
          clearInterval(timer);
          // 任何断线都终止本设备持有的会话；撤销和 401 握手失败也不能留下后台进程。
          this.active?.abort.abort();
          void (async () => {
            await this.active?.promise; await this.releasing?.catch(() => undefined);
            await this.backend.stopOwned().catch(error => console.error("断线清理尚未确认：", error instanceof Error ? error.message : "stop_failed"));
            if (!this.stopping) await new Promise(done => setTimeout(done, 1000));
            resolve();
          })();
        });
      });
    }
  }
}
