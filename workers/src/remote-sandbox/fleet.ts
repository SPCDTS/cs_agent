import { DurableObject } from "cloudflare:workers";
import { Type, type Static } from "typebox";
import { authenticated } from "../auth";
import type { Env } from "../env";
import { scopePrefix } from "../media/repository";
import { DescriptorSchema, RequirementsSchema, JobInputSchema, OutcomeSchema, DeviceFrameSchema, parse, parseFrame, validateSnapshot, mismatch, FILE_MAX_BYTES, SOURCE_MAX_BYTES,
  type Descriptor, type Outcome, type Lease, type JobInput, type ServerFrame } from "../../../runner/src/protocol";

type Device = { id: string; approval: "pending" | "approved" | "revoked"; tokenHash: string; descriptor: Descriptor; revision: string; createdAt: number };
type Pairing = { id: string; codeHash: string; deviceId: string; expiresAt: number; claimed: boolean };
type Allocation = { kind: "active"; lease: Lease; jobId: string | null; touchedAt: number }
  | { kind: "releasing" | "released"; lease: Lease };
type Phase = "dispatched" | "accepted" | "cancel_requested" | Outcome["kind"];
type Job = { id: string; workspace: string; deviceId: string; leaseId: string; fingerprint: string; phase: Phase;
  createdAt: number; deadline: number; outcomeHash: string | null; uploadBytes: number; uploadCount: number; notify: boolean };
type Log = { sequence: number; text: string };
type Connection = { deviceId: string; ready: boolean; helloAt: number };
export type CatalogEntry = {
  id: string; name: string; provider: "cloudflare" | "windows-wsb"; os: "linux" | "windows"; arch: string;
  shells: string[]; tools: { name: string; version: string }[]; taskTypes: string[]; memoryMiB: number | null;
  maxTimeoutMs: number; capabilityRevision: string; availability: "ready" | "busy" | "offline" | "draining";
  activeJobs: number; cache: { npm: boolean; git: boolean }; mismatch: string[];
};
const strict = { additionalProperties: false };
const ClaimSchema = Type.Object({ pairingId: Type.String({ pattern: "^[a-f0-9-]{36}$" }), code: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  tokenHash: Type.String({ pattern: "^[a-f0-9]{64}$" }), descriptor: DescriptorSchema }, strict);
const AcquireSchema = Type.Object({ sandboxId: Type.String({ pattern: "^remote:[a-f0-9-]{36}$" }), workspace: Type.String({ pattern: "^[a-zA-Z0-9:_-]{1,160}$" }),
  operationId: Type.String({ pattern: "^[a-zA-Z0-9:_-]{1,160}$" }), capabilityRevision: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  taskType: Type.Union([Type.Literal("shell.exec"), Type.Literal("node.test")]), requirements: RequirementsSchema }, strict);
export type AcquireInput = Static<typeof AcquireSchema>;
export async function hash(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(n => n.toString(16).padStart(2, "0")).join("");
}
function secret(): string { return [...crypto.getRandomValues(new Uint8Array(32))].map(n => n.toString(16).padStart(2, "0")).join(""); }
const resolved = (phase: Phase) => phase === "completed" || phase === "cancelled" || phase === "failed";
const terminal = (phase: Phase) => resolved(phase) || phase === "unknown";
const dataKey = (id: string, name: string) => "remote-jobs/" + id + "/" + name;
async function blobPrefix(id: string): Promise<string> { return await scopePrefix("remote:" + id) + "/workspace/blobs/"; }

/** 一个 owner 的设备、槽位与任务账本在同一对象中原子更新；大清单与结果放在 R2。 */
export class SandboxFleetDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }
  private readonly inputs = new Map<string, JobInput>();
  private socket(deviceId: string): WebSocket | undefined { return this.ctx.getWebSockets(deviceId).find(ws => ws.readyState === WebSocket.OPEN); }
  private available(id: string) {
    const ws = this.socket(id); if (!ws) return false;
    const connection: Connection = ws.deserializeAttachment();
    const heartbeat = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? connection.helloAt;
    return connection.ready && Date.now() - heartbeat < 60000;
  }
  private async arm(time: number) {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > time) await this.ctx.storage.setAlarm(time);
  }
  private send(deviceId: string, frame: ServerFrame): boolean {
    const ws = this.socket(deviceId); if (!ws) return false;
    try { ws.send(JSON.stringify(frame)); return true; } catch { return false; }
  }
  async createPairing() {
    if ((await this.ctx.storage.list<Device>({ prefix: "device:" })).size >= 32) throw new Error("device_limit");
    const id = crypto.randomUUID(), code = secret(), expiresAt = Date.now() + 600000;
    await this.ctx.storage.put("pair:" + id, { id, codeHash: await hash(code), deviceId: crypto.randomUUID(), expiresAt, claimed: false } satisfies Pairing);
    await this.arm(Date.now() + 15000);
    return { pairingId: id, code, expiresAt };
  }
  async claim(value: unknown) {
    const input = parse(ClaimSchema, value), codeHash = await hash(input.code), revision = await hash(JSON.stringify(input.descriptor));
    return this.ctx.storage.transaction(async tx => {
      const pair = await tx.get<Pairing>("pair:" + input.pairingId);
      if (!pair || pair.expiresAt < Date.now() || pair.codeHash !== codeHash) throw new Error("pairing_denied");
      const existing = await tx.get<Device>("device:" + pair.deviceId);
      if (pair.claimed) {
        if (!existing || existing.tokenHash !== input.tokenHash || existing.revision !== revision) throw new Error("pairing_denied");
        return { deviceId: existing.id, approval: existing.approval };
      }
      if ((await tx.list({ prefix: "device:" })).size >= 32) throw new Error("device_limit");
      const device: Device = { id: pair.deviceId, approval: "pending", tokenHash: input.tokenHash, descriptor: input.descriptor, revision, createdAt: Date.now() };
      await tx.put({ ["device:" + device.id]: device, ["pair:" + pair.id]: { ...pair, claimed: true } });
      return { deviceId: device.id, approval: device.approval };
    });
  }
  async approve(id: string) {
    await this.ctx.storage.transaction(async tx => {
      const device = await tx.get<Device>("device:" + id);
      if (!device || device.approval === "revoked") throw new Error("invalid_device_state");
      await tx.put("device:" + id, { ...device, approval: "approved" } satisfies Device);
    });
  }
  async revoke(id: string) {
    const device = await this.device(id);
    await this.ctx.storage.put("device:" + id, { ...device, approval: "revoked" } satisfies Device);
    const allocation = await this.ctx.storage.get<Allocation>("allocation:" + id);
    if (allocation?.kind === "active" && allocation.jobId) await this.cancel(allocation.lease.workspace, allocation.jobId);
    for (const ws of this.ctx.getWebSockets(id)) ws.close(1008, "revoked");
  }
  async devices() { return [...(await this.ctx.storage.list<Device>({ prefix: "device:" })).values()].map(({ tokenHash: _, ...device }) => ({ ...device, connected: this.available(device.id) })); }
  private async device(id: string): Promise<Device> {
    const found = await this.ctx.storage.get<Device>("device:" + id); if (!found) throw new Error("device_not_found"); return found;
  }
  async authorize(deviceId: string, authorization: string | null): Promise<boolean> {
    const device = await this.ctx.storage.get<Device>("device:" + deviceId), token = authorization?.replace(/^Bearer /, "");
    if (!device || device.approval !== "approved" || !token || !/^[a-f0-9]{64}$/.test(token)) return false;
    return authenticated(new Request("https://internal", { headers: { Authorization: "Bearer " + await hash(token) } }), device.tokenHash);
  }
  override async fetch(request: Request): Promise<Response> {
    const id = new URL(request.url).searchParams.get("device") ?? "";
    if (!await this.authorize(id, request.headers.get("Authorization"))) return new Response("unauthorized", { status: 401 });
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("websocket required", { status: 426 });
    for (const ws of this.ctx.getWebSockets(id)) ws.close(1000, "replaced");
    const { 0: client, 1: server } = new WebSocketPair();
    server.serializeAttachment({ deviceId: id, ready: false, helloAt: Date.now() } satisfies Connection); this.ctx.acceptWebSocket(server, [id]);
    return new Response(null, { status: 101, webSocket: client });
  }
  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const attachment: Connection = ws.deserializeAttachment(), device = await this.device(attachment.deviceId);
    if (this.socket(device.id) !== ws || device.approval !== "approved") return;
    try {
      if (typeof raw !== "string") throw new Error("invalid_request");
      const frame = parseFrame(DeviceFrameSchema, raw);
      if (frame.kind !== "hello" && !attachment.ready) throw new Error("hello_required");
      switch (frame.kind) {
        case "hello": {
          const revision = await hash(JSON.stringify(frame.descriptor)), allocation = await this.ctx.storage.get<Allocation>("allocation:" + device.id);
          if (allocation && allocation.kind !== "released" && device.revision !== revision) throw new Error("capability_changed_while_leased");
          await this.ctx.storage.put("device:" + device.id, { ...device, descriptor: frame.descriptor, revision });
          ws.serializeAttachment({ deviceId: device.id, ready: true, helloAt: Date.now() } satisfies Connection);
          this.send(device.id, { kind: "welcome", deviceId: device.id, capabilityRevision: revision });
          if (allocation?.kind === "active" && allocation.jobId) {
            const job = await this.job(allocation.jobId);
            if (job.phase === "cancel_requested" || job.phase === "unknown") this.send(device.id, { kind: "cancel", jobId: job.id });
            else if (!terminal(job.phase)) this.send(device.id, { kind: "execute", jobId: job.id });
          } else if (allocation?.kind === "releasing") this.send(device.id, { kind: "release", leaseId: allocation.lease.id });
          break;
        }
        case "accepted": {
          await this.ctx.storage.transaction(async tx => {
            const job = await tx.get<Job>("job:" + frame.jobId);
            if (!job || job.deviceId !== device.id || job.phase !== "dispatched") return;
            await tx.put("job:" + job.id, { ...job, phase: "accepted" } satisfies Job);
          }); break;
        }
        case "progress": {
          await this.ownedJob(device.id, frame.jobId);
          await this.ctx.storage.transaction(async tx => {
            const log = await tx.get<Log>("log:" + frame.jobId);
            if (log && frame.sequence <= log.sequence) return;
            // 最多 32 KiB UTF-8，独立于任务元数据，避免 KV 单值上限。
            const bytes = new TextEncoder().encode((log?.text ?? "") + frame.text);
            await tx.put("log:" + frame.jobId, { sequence: frame.sequence, text: new TextDecoder().decode(bytes.slice(-32768)) } satisfies Log);
          }); break;
        }
        case "outcome": await this.complete(device.id, frame.jobId, frame.outcome); break;
        case "released": await this.confirmRelease(device.id, frame.leaseId); break;
        default: { const exhaustive: never = frame; throw new Error(String(exhaustive)); }
      }
    } catch (error) { this.send(device.id, { kind: "error", error: error instanceof Error ? error.message.slice(0, 160) : "invalid_request" }); }
  }
  override webSocketClose(ws: WebSocket) { try { ws.close(); } catch { /* 已关闭。 */ } }
  override webSocketError(ws: WebSocket) { try { ws.close(1011, "connection_error"); } catch { /* 已关闭。 */ } }
  async catalog(taskType = "shell.exec", value: unknown = {}): Promise<CatalogEntry[]> {
    const requirements = parse(RequirementsSchema, value), rows: CatalogEntry[] = [{
      id: "cloudflare", name: "Cloudflare coding", provider: "cloudflare", os: "linux", arch: "managed",
      shells: ["bash"], tools: [], taskTypes: ["shell.exec"], memoryMiB: null, maxTimeoutMs: 120000,
      capabilityRevision: "builtin-v1", availability: "ready", activeJobs: 0, cache: { npm: false, git: false },
      mismatch: [...(taskType !== "shell.exec" ? ["task_type"] : []), ...(requirements.os === "windows" ? ["os"] : []),
        ...(requirements.shell === "powershell" ? ["shell"] : []), ...(requirements.memoryMiB || requirements.tools?.length ? ["unverified_requirements"] : [])],
    }];
    for (const device of (await this.ctx.storage.list<Device>({ prefix: "device:" })).values()) {
      if (device.approval !== "approved") continue;
      const allocation = await this.ctx.storage.get<Allocation>("allocation:" + device.id);
      rows.push({ id: "remote:" + device.id, name: device.descriptor.name, provider: device.descriptor.provider,
        os: device.descriptor.os, arch: device.descriptor.arch, shells: device.descriptor.shells, tools: device.descriptor.tools,
        taskTypes: device.descriptor.taskTypes, memoryMiB: device.descriptor.memoryMiB, maxTimeoutMs: device.descriptor.maxTimeoutMs,
        capabilityRevision: device.revision, availability: !this.available(device.id) ? "offline" : allocation?.kind === "releasing" ? "draining" : allocation?.kind === "active" ? "busy" : "ready",
        activeJobs: allocation?.kind === "active" && allocation.jobId ? 1 : 0, cache: device.descriptor.cache, mismatch: mismatch(device.descriptor, taskType, requirements) });
    }
    return rows;
  }
  async acquire(value: unknown): Promise<Lease> {
    const input = parse(AcquireSchema, value), deviceId = input.sandboxId.slice(7);
    const requestKey = "acquire:" + await hash(input.workspace + ":" + input.operationId), fingerprint = await hash(JSON.stringify(input));
    const lease = await this.ctx.storage.transaction(async tx => {
      const prior = await tx.get<{ fingerprint: string; lease: Lease }>(requestKey);
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new Error("operation_conflict");
        const allocation = await tx.get<Allocation>("allocation:" + deviceId);
        if (allocation?.kind !== "active" || allocation.lease.id !== prior.lease.id) throw new Error("lease_expired");
        return prior.lease;
      }
      const device = await tx.get<Device>("device:" + deviceId);
      if (!device || device.approval !== "approved") throw new Error("permission_denied");
      if (!this.available(deviceId)) throw new Error("unavailable");
      if (device.revision !== input.capabilityRevision) throw new Error("capability_changed");
      if (mismatch(device.descriptor, input.taskType, input.requirements).length) throw new Error("capability_mismatch");
      const current = await tx.get<Allocation>("allocation:" + deviceId);
      if (current && current.kind !== "released") throw new Error("busy");
      const lease: Lease = { ...input, id: crypto.randomUUID(), deviceId, createdAt: Date.now() };
      await tx.put({ ["allocation:" + deviceId]: { kind: "active", lease, jobId: null, touchedAt: Date.now() } satisfies Allocation, [requestKey]: { fingerprint, lease } });
      return lease;
    });
    await this.arm(Date.now() + 15000); return lease;
  }
  async release(lease: Lease): Promise<void> {
    await this.ctx.storage.transaction(async tx => {
      const current = await tx.get<Allocation>("allocation:" + lease.deviceId);
      if (!current || current.lease.id !== lease.id || current.lease.workspace !== lease.workspace) throw new Error("lease_expired");
      if (current.kind === "released") return;
      if (current.kind === "active" && current.jobId) throw new Error("job_running");
      await tx.put("allocation:" + lease.deviceId, { kind: "releasing", lease } satisfies Allocation);
    });
    this.send(lease.deviceId, { kind: "release", leaseId: lease.id });
  }
  private async confirmRelease(deviceId: string, leaseId: string) {
    await this.ctx.storage.transaction(async tx => {
      const allocation = await tx.get<Allocation>("allocation:" + deviceId);
      if (allocation?.kind === "releasing" && allocation.lease.id === leaseId) await tx.put("allocation:" + deviceId, { ...allocation, kind: "released" } satisfies Allocation);
    });
  }
  async start(value: JobInput): Promise<string> {
    const input = parse(JobInputSchema, value); validateSnapshot(input.source);
    const fingerprint = await hash(JSON.stringify(input)), inputKey = dataKey(input.id, "input-" + fingerprint);
    await this.env.ASSETS.put(inputKey, JSON.stringify(input));
    await this.ctx.storage.transaction(async tx => {
      const existing = await tx.get<Job>("job:" + input.id);
      if (existing) { if (existing.fingerprint !== fingerprint) throw new Error("operation_conflict"); return; }
      const device = await tx.get<Device>("device:" + input.lease.deviceId), allocation = await tx.get<Allocation>("allocation:" + input.lease.deviceId);
      if (!device || device.approval !== "approved" || allocation?.kind !== "active" || allocation.lease.id !== input.lease.id || allocation.lease.workspace !== input.lease.workspace) throw new Error("lease_expired");
      if (allocation.jobId) throw new Error("job_running");
      if (!this.available(device.id)) throw new Error("unavailable");
      const op = input.operation;
      if (op.kind !== allocation.lease.taskType || op.timeoutMs > device.descriptor.maxTimeoutMs ||
        op.kind === "shell.exec" && !device.descriptor.shells.includes(op.shell)) throw new Error("capability_mismatch");
      const job: Job = { id: input.id, workspace: input.lease.workspace, deviceId: device.id, leaseId: input.lease.id, fingerprint,
        createdAt: input.createdAt, deadline: input.deadline, phase: "dispatched", outcomeHash: null, uploadBytes: 0, uploadCount: 0, notify: false };
      await tx.put({ ["job:" + input.id]: job, ["allocation:" + device.id]: { ...allocation, jobId: input.id } satisfies Allocation });
    });
    this.send(input.lease.deviceId, { kind: "execute", jobId: input.id });
    await this.arm(Date.now() + 15000); return input.id;
  }
  private async job(id: string): Promise<Job> { const job = await this.ctx.storage.get<Job>("job:" + id); if (!job) throw new Error("job_not_found"); return job; }
  private async ownedJob(deviceId: string, id: string): Promise<Job> { const job = await this.job(id); if (job.deviceId !== deviceId) throw new Error("permission_denied"); return job; }
  async input(deviceId: string, id: string): Promise<JobInput> {
    const job = await this.ownedJob(deviceId, id), cached = this.inputs.get(id);
    if (cached) return cached;
    const object = await this.env.ASSETS.get(dataKey(id, "input-" + job.fingerprint));
    if (!object) throw new Error("input_missing");
    const input = parse(JobInputSchema, await object.json());
    if (this.inputs.size >= 2) this.inputs.delete(this.inputs.keys().next().value!);
    this.inputs.set(id, input); return input;
  }
  async inputBlob(deviceId: string, id: string, sha: string): Promise<Uint8Array> {
    const input = await this.input(deviceId, id), file = input.source.files.find(file => file.sha256 === sha);
    if (!file) throw new Error("not_found");
    const object = await this.env.ASSETS.get(await scopePrefix("workspace:" + input.lease.workspace) + "/workspace/blobs/" + sha);
    if (!object || object.size !== file.bytes) throw new Error("blob_corrupt");
    const bytes = new Uint8Array(await object.arrayBuffer());
    if (await hash(bytes) !== sha) throw new Error("blob_corrupt"); return bytes;
  }
  async upload(deviceId: string, id: string, sha: string, bytes: Uint8Array): Promise<void> {
    if (bytes.length > FILE_MAX_BYTES || await hash(bytes) !== sha) throw new Error("blob_corrupt");
    await this.ctx.storage.transaction(async tx => {
      const job = await tx.get<Job>("job:" + id), key = "upload:" + id + ":" + sha;
      if (!job || job.deviceId !== deviceId || resolved(job.phase)) throw new Error("permission_denied");
      const prior = await tx.get<number>(key);
      if (prior !== undefined) { if (prior !== bytes.length) throw new Error("blob_corrupt"); return; }
      if (job.uploadCount >= 20000 || job.uploadBytes + bytes.length > SOURCE_MAX_BYTES) throw new Error("workspace_quota");
      await tx.put({ [key]: bytes.length, ["job:" + id]: { ...job, uploadCount: job.uploadCount + 1, uploadBytes: job.uploadBytes + bytes.length } satisfies Job });
    });
    await this.env.ASSETS.put(await blobPrefix(id) + sha, bytes);
  }
  async complete(deviceId: string, id: string, value: unknown): Promise<void> {
    const outcome = parse(OutcomeSchema, value), outcomeHash = await hash(JSON.stringify(outcome)), job = await this.ownedJob(deviceId, id);
    if (resolved(job.phase)) {
      if (job.outcomeHash !== outcomeHash) throw new Error("operation_conflict");
      this.send(deviceId, { kind: "outcome_ack", jobId: id }); return;
    }
    if (outcome.kind === "completed") {
      validateSnapshot(outcome.snapshot);
      const input = await this.input(deviceId, id), original = new Map(input.source.files.map(file => [file.sha256, file]));
      for (const file of outcome.snapshot.files) {
        const uploaded = await this.ctx.storage.get<number>("upload:" + id + ":" + file.sha256);
        if (uploaded === file.bytes) {
          const object = await this.env.ASSETS.head(await blobPrefix(id) + file.sha256);
          if (!object || object.size !== file.bytes) throw new Error("blob_corrupt");
        } else {
          if (original.get(file.sha256)?.bytes !== file.bytes) throw new Error("blob_corrupt");
          await this.env.ASSETS.put(await blobPrefix(id) + file.sha256, await this.inputBlob(deviceId, id, file.sha256));
        }
      }
    }
    await this.env.ASSETS.put(dataKey(id, "outcome-" + outcomeHash), JSON.stringify(outcome));
    await this.ctx.storage.transaction(async tx => {
      const latest = await tx.get<Job>("job:" + id);
      if (!latest) throw new Error("job_not_found");
      if (resolved(latest.phase) && latest.outcomeHash !== outcomeHash) throw new Error("operation_conflict");
      await tx.put("job:" + id, { ...latest, phase: outcome.kind, outcomeHash, notify: true } satisfies Job);
    });
    await this.arm(Date.now() + 1000);
    this.send(deviceId, { kind: "outcome_ack", jobId: id });
  }
  async inspect(workspace: string, id: string) {
    const job = await this.job(id); if (job.workspace !== workspace) throw new Error("permission_denied");
    const object = job.outcomeHash ? await this.env.ASSETS.get(dataKey(id, "outcome-" + job.outcomeHash)) : null;
    return { input: await this.input(job.deviceId, id), phase: job.phase, outcome: object ? parse(OutcomeSchema, await object.json()) : null,
      log: (await this.ctx.storage.get<Log>("log:" + id)) ?? { sequence: -1, text: "" } };
  }
  async cancel(workspace: string, id: string) {
    const job = await this.ctx.storage.transaction(async tx => {
      const job = await tx.get<Job>("job:" + id);
      if (!job) throw new Error("job_not_found");
      if (job.workspace !== workspace) throw new Error("permission_denied");
      if (!terminal(job.phase)) await tx.put("job:" + id, { ...job, phase: "cancel_requested" } satisfies Job);
      return job;
    });
    if (!resolved(job.phase)) this.send(job.deviceId, { kind: "cancel", jobId: id });
    await this.arm(Date.now() + 15000);
  }
  async acknowledgeCommit(workspace: string, id: string) {
    await this.ctx.storage.transaction(async tx => {
      const job = await tx.get<Job>("job:" + id);
      if (!job || job.workspace !== workspace || !terminal(job.phase)) throw new Error("invalid_job_state");
      const allocation = await tx.get<Allocation>("allocation:" + job.deviceId);
      if (resolved(job.phase) && allocation?.kind === "active" && allocation.jobId === id)
        await tx.put("allocation:" + job.deviceId, { ...allocation, jobId: null, touchedAt: Date.now() } satisfies Allocation);
      await tx.put("job:" + id, { ...job, notify: false } satisfies Job);
    });
    await this.arm(Date.now() + 600000);
  }
  /** 仅管理员路由可调用；承认结果未知并封存任务，绝不宣称远端已停止。 */
  async abandon(id: string) {
    const job = await this.job(id);
    if (resolved(job.phase)) throw new Error("already_resolved");
    this.send(job.deviceId, { kind: "cancel", jobId: id });
    await this.complete(job.deviceId, id, { kind: "failed", error: "admin_abandoned_execution_unknown" });
    return { jobId: id, execution: "unknown", fenced: true };
  }
  private async deletePrefix(prefix: string) {
    for (;;) { const page = await this.env.ASSETS.list({ prefix, limit: 1000 }); if (!page.objects.length) return; await this.env.ASSETS.delete(page.objects.map(object => object.key)); }
  }
  override async alarm() {
    const now = Date.now();
    let nextAt: number | undefined;
    const schedule = (time: number) => { nextAt = Math.min(nextAt ?? Infinity, Math.max(now + 1000, time)); };
    for (const [key, pair] of await this.ctx.storage.list<Pairing>({ prefix: "pair:" })) {
      if (pair.expiresAt < now) await this.ctx.storage.delete(key); else schedule(pair.expiresAt);
    }
    for (const allocation of (await this.ctx.storage.list<Allocation>({ prefix: "allocation:" })).values()) {
      if (allocation.kind === "active" && !allocation.jobId) {
        if (now - allocation.touchedAt >= 600000) await this.release(allocation.lease);
        else schedule(allocation.touchedAt + 600000);
      }
    }
    for (const [key, job] of await this.ctx.storage.list<Job>({ prefix: "job:" })) {
      if (!terminal(job.phase)) {
        schedule(job.phase === "cancel_requested" ? job.deadline + 60000 : job.deadline);
        if (now > job.deadline + 60000) await this.complete(job.deviceId, job.id, { kind: "unknown", reason: "deadline_without_confirmation" });
        else if (now > job.deadline) await this.cancel(job.workspace, job.id);
      }
      if (job.notify) {
        try { await this.env.SANDBOX.get(this.env.SANDBOX.idFromString(job.workspace)).finishRemoteJob(job.id); }
        catch { schedule(now + 15000); }
      }
      if (!job.notify && resolved(job.phase) && now - job.createdAt > 7 * 86400000) {
        await this.deletePrefix(dataKey(job.id, "")); await this.deletePrefix(await blobPrefix(job.id));
        const uploads = [...(await this.ctx.storage.list({ prefix: "upload:" + job.id + ":" })).keys()];
        for (let at = 0; at < uploads.length; at += 128) await this.ctx.storage.delete(uploads.slice(at, at + 128));
        await this.ctx.storage.delete([key, "log:" + job.id]);
      } else if (resolved(job.phase)) schedule(job.createdAt + 7 * 86400000);
    }
    const already = await this.ctx.storage.getAlarm();
    if (nextAt !== undefined) await this.ctx.storage.setAlarm(Math.min(nextAt, already ?? Infinity));
  }
}
