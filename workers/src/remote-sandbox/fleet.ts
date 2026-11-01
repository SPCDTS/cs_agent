import { DurableObject } from "cloudflare:workers";
import { Type, type Static } from "typebox";
import { authenticated } from "../auth";
import type { Env } from "../env";
import type { CatalogEntry } from "./wire";
import { CLOUDFLARE_SANDBOX } from "../sandbox/registration";
export type { CatalogEntry } from "./wire";
import { DescriptorSchema, RequirementsSchema, JobInputSchema, DeviceFrameSchema, IdSchema, ToolNameSchema, parse, parseFrame,
  validateDescriptor, validateToolArguments, validateOutcome, mismatch,
  type Descriptor, type Outcome, type Lease, type JobInput, type ServerFrame } from "../../../runner/src/protocol";

type Device = { id: string; approval: "pending" | "approved" | "revoked"; tokenHash: string; descriptor: Descriptor; revision: string; createdAt: number };
type Pairing = { id: string; codeHash: string; deviceId: string; expiresAt: number; claimed: boolean };
type Allocation = { kind: "active" | "lost"; lease: Lease; jobId: string | null; touchedAt: number }
  | { kind: "releasing" | "released"; lease: Lease };
type Phase = "dispatched" | "accepted" | "cancel_requested" | Outcome["kind"];
type Job = { id: string; workspace: string; deviceId: string; leaseId: string; fingerprint: string; phase: Phase;
  createdAt: number; deadline: number; outcomeHash: string | null };
type Log = { sequence: number; text: string };
type Connection = { deviceId: string; ready: boolean; helloAt: number };
const strict = { additionalProperties: false };
const ClaimSchema = Type.Object({ pairingId: Type.String({ pattern: "^[a-f0-9-]{36}$" }), code: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  tokenHash: Type.String({ pattern: "^[a-f0-9]{64}$" }), descriptor: DescriptorSchema }, strict);
const AcquireSchema = Type.Object({ sandboxId: Type.String({ pattern: "^remote:[a-f0-9-]{36}$" }), workspace: Type.String({ pattern: "^[a-zA-Z0-9:_-]{1,160}$" }),
  operationId: Type.String({ pattern: "^[a-zA-Z0-9:_-]{1,160}$" }), capabilityRevision: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  requirements: RequirementsSchema }, strict);
export type AcquireInput = Static<typeof AcquireSchema>;
const InvokeSchema = Type.Object({ leaseId: IdSchema, tool: ToolNameSchema, arguments: Type.Record(Type.String(), Type.Unknown()),
  timeoutMs: Type.Integer({ minimum: 1000, maximum: 1200000 }) }, strict);
export type InvokeInput = Static<typeof InvokeSchema>;
export async function hash(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(n => n.toString(16).padStart(2, "0")).join("");
}
function secret(): string { return [...crypto.getRandomValues(new Uint8Array(32))].map(n => n.toString(16).padStart(2, "0")).join(""); }
const resolved = (phase: Phase) => phase === "completed" || phase === "cancelled" || phase === "failed";
const terminal = (phase: Phase) => resolved(phase) || phase === "unknown";
const dataKey = (id: string, name: string) => "remote-jobs/" + id + "/" + name;

/** 设备、租约、参数和任务收据原子保存；较大的工具结果放 R2，不同步远端文件。 */
export class SandboxFleetDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }
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
    const input = parse(ClaimSchema, value); validateDescriptor(input.descriptor);
    const codeHash = await hash(input.code), revision = await hash(JSON.stringify(input.descriptor));
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
    if ((allocation?.kind === "active" || allocation?.kind === "lost") && allocation.jobId) await this.cancel(allocation.lease.workspace, allocation.jobId);
    for (const ws of this.ctx.getWebSockets(id)) ws.close(1008, "revoked");
  }
  async devicesJson(): Promise<string> { return JSON.stringify([...(await this.ctx.storage.list<Device>({ prefix: "device:" })).values()].map(({ tokenHash: _, ...device }) => {
    let compatible = true; try { validateDescriptor(device.descriptor); } catch { compatible = false; }
    return { ...device, protocolCompatible: compatible, connected: this.available(device.id) };
  })); }
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
          validateDescriptor(frame.descriptor);
          const revision = await hash(JSON.stringify(frame.descriptor)), allocation = await this.ctx.storage.get<Allocation>("allocation:" + device.id);
          if (allocation && allocation.kind !== "released" && device.revision !== revision) throw new Error("capability_changed_while_leased");
          await this.ctx.storage.put("device:" + device.id, { ...device, descriptor: frame.descriptor, revision });
          ws.serializeAttachment({ deviceId: device.id, ready: true, helloAt: Date.now() } satisfies Connection);
          this.send(device.id, { kind: "welcome", deviceId: device.id, capabilityRevision: revision });
          if ((allocation?.kind === "active" || allocation?.kind === "lost") && allocation.jobId) {
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
  async catalogJson(value: unknown = {}): Promise<string> {
    const requirements = parse(RequirementsSchema, value), rows: CatalogEntry[] = [{
      ...CLOUDFLARE_SANDBOX,
      mismatch: [...(requirements.os && requirements.os !== CLOUDFLARE_SANDBOX.os ? ["os"] : []),
        ...(requirements.memoryMiB ? ["unverified_memory"] : []), ...(requirements.tools ?? []).filter(name => !CLOUDFLARE_SANDBOX.codeModeTools.includes(name)).map(name => "tool:" + name)],
    }];
    for (const device of (await this.ctx.storage.list<Device>({ prefix: "device:" })).values()) {
      if (device.approval !== "approved") continue;
      // 旧 runner 必须升级声明；保留管理员可见记录，不把旧任务误当成可调用工具。
      try { validateDescriptor(device.descriptor); } catch { continue; }
      const allocation = await this.ctx.storage.get<Allocation>("allocation:" + device.id);
      rows.push({ id: "remote:" + device.id, name: device.descriptor.name, provider: device.descriptor.provider,
        os: device.descriptor.os, arch: device.descriptor.arch, tools: device.descriptor.tools, ...(device.descriptor.environment ? { environment: device.descriptor.environment } : {}),
        memoryMiB: device.descriptor.memoryMiB, maxTimeoutMs: device.descriptor.maxTimeoutMs,
        capabilityRevision: device.revision, availability: !this.available(device.id) ? "offline" : allocation?.kind === "releasing" || allocation?.kind === "lost" ? "draining" : allocation?.kind === "active" ? "busy" : "ready",
        activeJobs: (allocation?.kind === "active" || allocation?.kind === "lost") && allocation.jobId ? 1 : 0,
        workspaceRoot: device.descriptor.workspaceRoot ?? "tool-specific", instructions: device.descriptor.instructions, persistence: device.descriptor.persistence,
        mismatch: mismatch(device.descriptor, requirements) });
    }
    return JSON.stringify(rows);
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
      validateDescriptor(device.descriptor);
      if (mismatch(device.descriptor, input.requirements).length) throw new Error("capability_mismatch");
      const current = await tx.get<Allocation>("allocation:" + deviceId);
      if (current && current.kind !== "released") throw new Error("busy");
      const lease: Lease = { ...input, id: crypto.randomUUID(), deviceId, createdAt: Date.now() };
      await tx.put({ ["allocation:" + deviceId]: { kind: "active", lease, jobId: null, touchedAt: Date.now() } satisfies Allocation,
        ["lease:" + lease.id]: deviceId, [requestKey]: { fingerprint, lease } });
      return lease;
    });
    await this.arm(Date.now() + 15000); return lease;
  }
  async sessions(workspace: string) {
    return [...(await this.ctx.storage.list<Allocation>({ prefix: "allocation:" })).values()]
      .filter(item => item.lease.workspace === workspace && item.kind !== "released")
      .map(item => ({ lease: item.lease, state: item.kind, jobId: "jobId" in item ? item.jobId : null }));
  }
  private async allocation(workspace: string, leaseId: string): Promise<Allocation> {
    const deviceId = await this.ctx.storage.get<string>("lease:" + leaseId);
    const allocation = deviceId ? await this.ctx.storage.get<Allocation>("allocation:" + deviceId) : undefined;
    if (!allocation || allocation.lease.id !== leaseId || allocation.lease.workspace !== workspace) throw new Error("lease_expired");
    return allocation;
  }
  async release(workspace: string, leaseId: string): Promise<void> {
    const { lease } = await this.allocation(workspace, leaseId);
    await this.ctx.storage.transaction(async tx => {
      const current = await tx.get<Allocation>("allocation:" + lease.deviceId);
      if (!current || current.lease.id !== lease.id || current.lease.workspace !== lease.workspace) throw new Error("lease_expired");
      if (current.kind === "released") return;
      if ((current.kind === "active" || current.kind === "lost") && current.jobId) throw new Error("job_running");
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
  async invoke(workspace: string, operationId: string, value: unknown) {
    parse(IdSchema, workspace); parse(IdSchema, operationId);
    const request = parse(InvokeSchema, value), fingerprint = await hash(JSON.stringify({ workspace, ...request }));
    const key = "call:" + await hash(workspace + ":" + operationId);
    const prior = await this.ctx.storage.get<{ fingerprint: string; jobId: string }>(key);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new Error("operation_conflict");
      const job = await this.job(prior.jobId);
      // 事务提交后可能在发送前中断；runner journal 使重复通知不会重复执行。
      if (job.phase === "dispatched") this.send(job.deviceId, { kind: "execute", jobId: job.id });
      await this.arm(Date.now() + 15000);
      return { jobId: job.id, phase: job.phase };
    }
    const allocation = await this.allocation(workspace, request.leaseId);
    if (allocation.kind !== "active") throw new Error(allocation.kind === "lost" ? "session_lost" : "lease_expired");
    const device = await this.device(allocation.lease.deviceId);
    const args = validateToolArguments(validateDescriptor(device.descriptor), request.tool, request.arguments);
    if (request.timeoutMs > device.descriptor.maxTimeoutMs) throw new Error("capability_mismatch");
    const now = Date.now(), id = crypto.randomUUID();
    const input: JobInput = { id, lease: allocation.lease, tool: request.tool, arguments: args,
      timeoutMs: request.timeoutMs, createdAt: now, deadline: now + request.timeoutMs + 180000 };
    // 参数上限 64 KiB，连同租约小于 DO 单值上限，与收据一起提交，不生成 R2 暂存孤儿。
    const job = await this.ctx.storage.transaction(async tx => {
      const prior = await tx.get<{ fingerprint: string; jobId: string }>(key);
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new Error("operation_conflict");
        const existing = await tx.get<Job>("job:" + prior.jobId);
        if (!existing) throw new Error("job_expired");
        return existing;
      }
      const currentDevice = await tx.get<Device>("device:" + device.id), current = await tx.get<Allocation>("allocation:" + device.id);
      if (!currentDevice || currentDevice.approval !== "approved" || current?.kind !== "active" || current.lease.id !== input.lease.id || current.lease.workspace !== workspace) throw new Error("lease_expired");
      if (currentDevice.revision !== input.lease.capabilityRevision) throw new Error("capability_changed");
      if (current.jobId) throw new Error("job_running");
      if (!this.available(device.id)) throw new Error("unavailable");
      const job: Job = { id, workspace, deviceId: device.id, leaseId: input.lease.id, fingerprint,
        createdAt: now, deadline: input.deadline, phase: "dispatched", outcomeHash: null };
      await tx.put({ ["job:" + id]: job, ["allocation:" + device.id]: { ...current, jobId: id, touchedAt: now } satisfies Allocation,
        ["input:" + id]: JSON.stringify(input), [key]: { fingerprint, jobId: id } });
      return job;
    });
    if (!terminal(job.phase)) this.send(device.id, { kind: "execute", jobId: job.id });
    await this.arm(Date.now() + 15000); return { jobId: job.id, phase: job.phase };
  }
  private async job(id: string): Promise<Job> { const job = await this.ctx.storage.get<Job>("job:" + id); if (!job) throw new Error("job_not_found"); return job; }
  private async ownedJob(deviceId: string, id: string): Promise<Job> { const job = await this.job(id); if (job.deviceId !== deviceId) throw new Error("permission_denied"); return job; }
  async inputJson(deviceId: string, id: string): Promise<string> {
    await this.ownedJob(deviceId, id);
    const json = await this.ctx.storage.get<string>("input:" + id);
    if (!json) throw new Error("input_missing");
    return JSON.stringify(parse(JobInputSchema, JSON.parse(json)));
  }
  async complete(deviceId: string, id: string, value: unknown): Promise<void> {
    const outcome = validateOutcome(value), outcomeHash = await hash(JSON.stringify(outcome)), job = await this.ownedJob(deviceId, id);
    if (resolved(job.phase)) {
      if (job.outcomeHash !== outcomeHash) throw new Error("operation_conflict");
      this.send(deviceId, { kind: "outcome_ack", jobId: id }); return;
    }
    await this.env.ASSETS.put(dataKey(id, "outcome-" + outcomeHash), JSON.stringify(outcome));
    await this.ctx.storage.transaction(async tx => {
      const latest = await tx.get<Job>("job:" + id);
      if (!latest) throw new Error("job_not_found");
      if (resolved(latest.phase) && latest.outcomeHash !== outcomeHash) throw new Error("operation_conflict");
      await tx.put("job:" + id, { ...latest, phase: outcome.kind, outcomeHash } satisfies Job);
      const allocation = await tx.get<Allocation>("allocation:" + deviceId);
      if ((allocation?.kind === "active" || allocation?.kind === "lost") && allocation.jobId === id) {
        await tx.put("allocation:" + deviceId, { ...allocation,
          kind: allocation.kind === "lost" || outcome.sessionLost ? "lost" : "active",
          jobId: resolved(outcome.kind) ? null : id, touchedAt: Date.now() } satisfies Allocation);
      }
    });
    await this.arm(Date.now() + 1000);
    this.send(deviceId, { kind: "outcome_ack", jobId: id });
  }
  async inspectJson(workspace: string, id: string): Promise<string> {
    const job = await this.job(id); if (job.workspace !== workspace) throw new Error("permission_denied");
    const object = job.outcomeHash ? await this.env.ASSETS.get(dataKey(id, "outcome-" + job.outcomeHash)) : null;
    return JSON.stringify({ jobId: id, leaseId: job.leaseId, phase: job.phase, outcome: object ? validateOutcome(await object.json()) : null,
      log: (await this.ctx.storage.get<Log>("log:" + id)) ?? { sequence: -1, text: "" } });
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
  /** 仅管理员路由可调用；承认结果未知并封存任务，绝不宣称远端已停止。 */
  async abandon(id: string) {
    const job = await this.job(id);
    if (resolved(job.phase)) throw new Error("already_resolved");
    this.send(job.deviceId, { kind: "cancel", jobId: id });
    await this.complete(job.deviceId, id, { kind: "failed", error: "admin_abandoned_execution_unknown", sessionLost: true });
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
      if ((allocation.kind === "active" || allocation.kind === "lost") && !allocation.jobId) {
        if (now - allocation.touchedAt >= 600000) await this.release(allocation.lease.workspace, allocation.lease.id);
        else schedule(allocation.touchedAt + 600000);
      }
    }
    for (const [key, job] of await this.ctx.storage.list<Job>({ prefix: "job:" })) {
      if (!terminal(job.phase)) {
        schedule(job.phase === "cancel_requested" ? job.deadline + 60000 : job.deadline);
        if (now > job.deadline + 60000) await this.complete(job.deviceId, job.id, { kind: "unknown", reason: "deadline_without_confirmation" });
        else if (now > job.deadline) await this.cancel(job.workspace, job.id);
      }
      if (resolved(job.phase) && now - job.createdAt > 7 * 86400000) {
        await this.deletePrefix(dataKey(job.id, ""));
        await this.ctx.storage.delete([key, "log:" + job.id, "input:" + job.id]);
      } else if (resolved(job.phase)) schedule(job.createdAt + 7 * 86400000);
    }
    const already = await this.ctx.storage.getAlarm();
    if (nextAt !== undefined) await this.ctx.storage.setAlarm(Math.min(nextAt, already ?? Infinity));
  }
}
