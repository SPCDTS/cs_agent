import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Backend, Execution, ExecutionStatus } from "./domain.ts";
import { closeNativeSession, retireWsbScratch } from "./wsb-execution.ts";
import {
  evidence, executionFiles, Heartbeat, JobReceipt, JobRequest, Marker, record, SessionIntent, sessionFiles, wsbSessionDir,
} from "./wsb-evidence.ts";
import { nativeWsb, type NativeWsb } from "./wsb-native.ts";

type Helper = { role: "guard"; dir: string } | { role: "execute"; dir: string; id: string };
interface WsbAdapters {
  native?: NativeWsb;
  launch?: (request: Helper) => Promise<void>;
  stage?: (runtime: string) => Promise<void>;
}
const bundle = fileURLToPath(new URL("../dist/", import.meta.url));

async function launchHelper(request: Helper): Promise<void> {
  const helper = path.join(bundle, "wsb-start-helper.mjs");
  await fs.access(helper);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [helper, request.role, request.dir, ...(request.role === "execute" ? [request.id] : [])],
      { detached: true, windowsHide: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}

async function stageRuntime(runtime: string): Promise<void> {
  await fs.mkdir(runtime);
  await fs.copyFile(process.execPath, path.join(runtime, "node.exe"));
  await fs.copyFile(path.join(bundle, "guest.mjs"), path.join(runtime, "guest.mjs"));
}

export class WsbBackend implements Backend {
  readonly #state: string;
  readonly #native: NativeWsb;
  readonly #launch: NonNullable<WsbAdapters["launch"]>;
  readonly #stage: NonNullable<WsbAdapters["stage"]>;
  readonly #stops = new Map<string, Promise<boolean>>();

  constructor(stateDir: string, adapters: WsbAdapters = {}) {
    this.#state = path.resolve(stateDir);
    this.#native = adapters.native ?? nativeWsb;
    this.#launch = adapters.launch ?? launchHelper;
    this.#stage = adapters.stage ?? stageRuntime;
  }

  async dispatch(execution: Execution): Promise<void> {
    const { command, target, id, sessionId, deadline } = execution;
    if (!sessionId || command.kind !== "powershell" || target.kind !== "wsb") throw new Error("invalid_wsb_execution");
    const dir = wsbSessionDir(this.#state, sessionId), session = sessionFiles(dir), job = executionFiles(dir, id);
    await fs.mkdir(job.root, { recursive: true });
    if (!await record(job.request, { deadline, preparedAt: Date.now() })) return;
    try {
      if (await evidence(session.closing, Marker) || Date.now() >= deadline) {
        await this.stop(execution);
        return;
      }
      if (!await evidence(session.intent, SessionIntent)) {
        await this.#stage(session.runtime);
        const created = await record(session.intent, { nativeId: randomUUID(), deadline: Date.now() + target.maxLifetimeMs, memoryMb: target.memoryMb });
        if (created) await this.#launch({ role: "guard", dir });
      }
      await fs.mkdir(job.inputDir);
      await record(job.input, { id, script: command.script, cwd: command.cwd, deadline });
      if (!await evidence(session.closing, Marker)) await this.#launch({ role: "execute", dir, id });
      else await this.stop(execution);
    } catch {
      await record(job.receipt, { state: "failed", error: "wsb_helper_not_dispatched" });
      await this.closeSession(sessionId);
    }
  }

  async inspect(execution: Execution): Promise<ExecutionStatus> {
    if (!execution.sessionId) throw new Error("invalid_wsb_execution");
    const dir = wsbSessionDir(this.#state, execution.sessionId), job = executionFiles(dir, execution.id);
    const receipt = await evidence(job.receipt, JobReceipt);
    if (receipt) return receipt;
    if (await evidence(job.issue, Marker)) return { state: "unknown", error: "wsb_execution_unconfirmed" };
    if (await evidence(sessionFiles(dir).closed, Marker)) return this.#confirmStopped(job);
    const request = await evidence(job.request, JobRequest);
    if (!request) return { state: "unknown", error: "wsb_dispatch_unconfirmed" };
    const heartbeat = await evidence(job.heartbeat, Heartbeat);
    if (Date.now() - (heartbeat ?? request.preparedAt) < 5000) return { state: "running" };
    return { state: "unknown", error: "wsb_helper_unreachable" };
  }

  async stop(execution: Execution): Promise<ExecutionStatus> {
    if (!execution.sessionId) throw new Error("invalid_wsb_execution");
    const job = executionFiles(wsbSessionDir(this.#state, execution.sessionId), execution.id);
    const receipt = await evidence(job.receipt, JobReceipt);
    if (receipt) return receipt;
    if (!await this.closeSession(execution.sessionId)) return { state: "unknown", error: "wsb_stop_unconfirmed" };
    return this.#confirmStopped(job);
  }

  closeSession(sessionId: string): Promise<boolean> {
    const current = this.#stops.get(sessionId);
    if (current) return current;
    const dir = wsbSessionDir(this.#state, sessionId);
    const result = closeNativeSession(dir, this.#native).then(async stopped => {
      if (stopped) await retireWsbScratch(dir).catch(() => undefined);
      return stopped;
    }).catch(() => false).finally(() => this.#stops.delete(sessionId));
    this.#stops.set(sessionId, result);
    return result;
  }

  async #confirmStopped(job: ReturnType<typeof executionFiles>): Promise<JobReceipt> {
    await fs.mkdir(job.root, { recursive: true });
    await record(job.receipt, { state: "cancelled" });
    const receipt = await evidence(job.receipt, JobReceipt);
    if (!receipt) throw new Error("wsb_terminal_evidence_missing");
    return receipt;
  }
}

export function createWsbBackend(stateDir: string): WsbBackend {
  return new WsbBackend(stateDir);
}
