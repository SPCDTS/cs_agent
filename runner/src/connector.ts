import { promises as fs } from "node:fs";
import path from "node:path";
import { WebSocket } from "ws";
import { Type } from "typebox";
import { parse, parseFrame, ServerFrameSchema, JobInputSchema, OutcomeSchema, type DeviceFrame, type Outcome, type JobInput } from "./protocol.ts";
import { atomicJson, exists, plainFile, readJson, sha256, removeInside } from "./files.ts";
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
export async function request(base: string, token: string | undefined, pathname: string, init: RequestInit = {}, limit = 8 * 1024 * 1024) {
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
  readonly backend: Pick<WsbBackend, "run" | "stopOwned">;
  private readonly credentials: () => Promise<string>;
  private readonly capabilities: () => Promise<import("./protocol.ts").Descriptor>;
  private socket?: WebSocket;
  private active?: { id: string; abort: AbortController; promise: Promise<void> };
  private stopping = false;
  private token = "";
  constructor(state: string, config: Config, bundleDir: string, adapters?: {
    backend: Pick<WsbBackend, "run" | "stopOwned">; credentials(): Promise<string>; capabilities(): Promise<import("./protocol.ts").Descriptor>;
  }) {
    this.state = path.resolve(state); this.config = config; this.backend = adapters?.backend ?? new WsbBackend(this.state, config, bundleDir);
    this.credentials = adapters?.credentials ?? (() => protectToken(config.tokenProtected, true));
    this.capabilities = adapters?.capabilities ?? (() => descriptor(config));
  }
  private prefix(id: string) { return "/sandbox-devices/" + this.config.deviceId + "/jobs/" + id; }
  private send(frame: DeviceFrame) { if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(frame)); }
  private async post(id: string, outcome: Outcome) {
    if (outcome.kind === "completed") {
      const input = parse(JobInputSchema, await readJson(path.join(this.state, "jobs", id, "input/input.json")));
      const originals = new Set(input.source.files.map(file => file.sha256));
      for (const file of outcome.snapshot.files) {
        if (originals.has(file.sha256)) continue;
        const bytes = await plainFile(path.join(this.state, "jobs", id, "output/objects"), file.sha256);
        await request(this.config.origin, this.token, this.prefix(id) + "/objects/" + file.sha256, { method: "PUT", body: new Uint8Array(bytes) }, 65536);
      }
    }
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
      const outcome: Outcome = { kind: "unknown", reason: "connector_restarted_after_dispatch" };
      await atomicJson(journalFile, { state: "finished", outcome }); await this.post(id, outcome); return;
    }
    const input = parse(JobInputSchema, JSON.parse((await request(this.config.origin, this.token, this.prefix(id) + "/input")).toString("utf8")));
    if (input.id !== id || input.lease.deviceId !== this.config.deviceId) throw new Error("job_scope_mismatch");
    await fs.mkdir(path.join(directory, "input/objects"), { recursive: true });
    for (const file of input.source.files) {
      const bytes = await request(this.config.origin, this.token, this.prefix(id) + "/objects/" + file.sha256, {}, 10 * 1024 * 1024);
      if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256) throw new Error("blob_corrupt");
      await fs.writeFile(path.join(directory, "input/objects", file.sha256), bytes);
    }
    await atomicJson(path.join(directory, "input/input.json"), input);
    // 在任何 guest 执行之前持久化；重连只能回传结果，不重跑命令。
    await atomicJson(journalFile, { state: "started" });
    this.send({ kind: "accepted", jobId: id });
    let sequence = 0, outcome: Outcome;
    try { outcome = Date.now() >= input.deadline ? { kind: "cancelled", reason: "expired_before_execution" } : await this.backend.run(input, abort.signal, text => this.send({ kind: "progress", jobId: id, sequence: sequence++, text })); }
    catch {
      await this.backend.stopOwned();
      outcome = { kind: "unknown", reason: "sandbox_execution_unconfirmed" };
    }
    await atomicJson(journalFile, { state: "finished", outcome });
    await this.post(id, outcome);
  }
  private start(id: string) {
    if (this.active?.id === id) { this.send({ kind: "accepted", jobId: id }); return; }
    if (this.active) throw new Error("local_slot_busy");
    const abort = new AbortController();
    const promise = this.execute(id, abort).catch(error => { console.error("任务回传未完成，等待重连重试：", error instanceof Error ? error.message : "runner_error"); this.socket?.close(1011, "retry_result"); })
      .finally(() => { if (this.active?.id === id) this.active = undefined; });
    this.active = { id, abort, promise };
  }
  private async cancel(id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("invalid_job_id");
    if (this.active?.id === id) { this.active.abort.abort(); await this.active.promise; return; }
    const journalFile = path.join(this.state, "jobs", id, "journal.json");
    if (await exists(journalFile)) {
      const journal = parse(JournalSchema, await readJson(journalFile));
      if (journal.state === "acknowledged") return;
      if (journal.state === "finished" && journal.outcome.kind !== "unknown") { await this.post(id, journal.outcome); return; }
    }
    await this.backend.stopOwned();
    const outcome: Outcome = { kind: "cancelled", reason: "instance_stop_confirmed_result_not_replayed" };
    await atomicJson(journalFile, { state: "finished", outcome }); await this.post(id, outcome);
  }
  private async acknowledge(id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("invalid_job_id");
    const directory = path.join(this.state, "jobs", id), journalFile = path.join(directory, "journal.json");
    const journal = parse(JournalSchema, await readJson(journalFile));
    if (journal.state !== "finished" || journal.outcome.kind === "unknown") return;
    await atomicJson(journalFile, { state: "acknowledged" });
    // 云端已经持久接收，保留小型去重凭据，清理仅属于本任务的源文件、输出与缓存副本。
    for (const name of ["input", "output", "npm"]) await removeInside(directory, path.join(directory, name));
  }
  async stop() { this.stopping = true; this.active?.abort.abort(); this.socket?.close(); await this.active?.promise; await this.backend.stopOwned(); }
  async run() {
    this.token = await this.credentials();
    const capabilities = await this.capabilities();
    while (!this.stopping) {
      await new Promise<void>(resolve => {
        const url = new URL(origin(this.config.origin) + "/sandbox-devices/" + this.config.deviceId + "/connect");
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        const socket = new WebSocket(url, { headers: { Authorization: "Bearer " + this.token }, maxPayload: 128 * 1024, handshakeTimeout: 15000, followRedirects: false });
        this.socket = socket;
        let lastPong = Date.now(), disconnectTimer: NodeJS.Timeout | undefined;
        const timer = setInterval(() => {
          if (Date.now() - lastPong > 45000) { this.active?.abort.abort(); socket.terminate(); }
          else if (socket.readyState === WebSocket.OPEN) socket.send("ping");
        }, 15000);
        socket.on("open", () => { console.log("连接已建立，正在声明设备能力。"); this.send({ kind: "hello", protocolVersion: 1, descriptor: capabilities }); });
        socket.on("message", data => {
          const raw = data.toString(); if (raw === "pong") { lastPong = Date.now(); return; }
          let frame;
          try { frame = parseFrame(ServerFrameSchema, raw); } catch { socket.close(1008, "invalid_frame"); return; }
          switch (frame.kind) {
            case "welcome": console.log("设备已就绪：", frame.deviceId); break;
            case "execute": try { this.start(frame.jobId); } catch { socket.close(1011, "local_slot_busy"); } break;
            case "cancel": void this.cancel(frame.jobId).catch(() => socket.close(1011, "cancel_failed")); break;
            case "release": void (this.active?.promise ?? Promise.resolve()).then(() => this.send({ kind: "released", leaseId: frame.leaseId })); break;
            case "outcome_ack": void this.acknowledge(frame.jobId).catch(() => undefined); break;
            case "error": console.error("Worker 拒绝请求：", frame.error); socket.close(1008, "protocol_rejected"); break;
            default: { const exhaustive: never = frame; throw new Error(String(exhaustive)); }
          }
        });
        socket.on("error", () => undefined);
        socket.on("close", () => {
          clearInterval(timer);
          // 断线立即终止实例；完成的 journal 会在下一次连接时重新回传。
          this.active?.abort.abort();
          disconnectTimer = setTimeout(resolve, 5000);
          if (this.stopping) { clearTimeout(disconnectTimer); resolve(); }
        });
      });
    }
  }
}
