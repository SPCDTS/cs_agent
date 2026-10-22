/**
 * 回合编排（设计 §4、§8）：
 * - BackendRouter：ThreadHost 的适配器入口，按会话键选择后端（面板设置与覆盖表；owner 线程取首个 owner 账号私聊的覆盖），
 *   不按单条输入的 scope——一个会话同一时间只由一个后端服务（§4.3）。后端属于会话：plan 选定、宿主落盘在会话文档，
 *   开轮（含重启后恢复未确认的开轮）按会话后端执行；配置改为别的后端时，会话当前后端在该会话仍有工作
 *   （pi 子 agent 在跑、codex 回合或子 agent 线程未结束）时，本轮仍用旧后端，切换在它结束后生效。开轮时冻结设置快照；
 *   插话、恢复、放弃按回合 id 前缀（pi: / codex:）交给对应后端；后端不可用时开轮重试，超过 2 分钟才算投递失败。
 * - TurnMonitor：宿主事件的外层处理——Inbox 状态、观测、定时运行统计、出错提示（同一会话 10 分钟内最多一条）、
 *   回合结束后补传附件；看门狗：回合连续 30 分钟没有任何事件即中止（随后按回合失败提示）。
 */
import type { InboundRecord, TurnBinding } from "../channel/types.js";
import { log } from "../shared/log.js";
import { trace } from "../shared/trace.js";
import type { BackendName, TicketSettings } from "./backends/types.js";
import type { ThreadHost } from "./host/thread-host.js";
import { STALL_MS } from "./host/thread-host.js";
import type { OwnerIds } from "../shared/owners.js";
import type { InputRef, StartTurnResult, ThreadAdapter, ThreadHostEvents, ThreadKey, TurnContext, TurnEnded, TurnOutcome } from "./host/types.js";
import { TURN_NOTICES } from "./replies.js";
import type { SendService } from "./send-service.js";
import type { TurnSettings } from "./turn-settings.js";

/** 后端适配器：开轮时额外接收本轮设置快照。 */
export interface BackendAdapter extends ThreadAdapter {
  startTurn(threadKey: ThreadKey, inputs: readonly InputRef[], ctx: TurnContext, settings?: TicketSettings): Promise<StartTurnResult>;
}

/** 后端不可用超过重试时长：输入无法投递（§8.1 第三种提示）。 */
export class UndeliverableError extends Error {
  override readonly name = "UndeliverableError";
}

export interface BackendRouterOptions {
  backends: Partial<Record<BackendName, BackendAdapter>>;
  settings: TurnSettings;
  turns: { records(inputs: readonly Pick<InputRef, "inboundKey">[]): InboundRecord[] };
  /** 只选后端（面板设置与覆盖表，不做档位路由）；缺省取 settings 快照的 backend */
  backendFor?: (scope: string) => BackendName;
  /** owner 线程按首个 owner 账号的私聊 scope 选择后端 */
  owners?: OwnerIds | (() => OwnerIds);
  /** 开轮失败的重试总时长，默认 2 分钟 */
  retryMs?: number;
  retryDelayMs?: number;
  now?: () => number;
}

export class BackendRouter implements ThreadAdapter {
  constructor(private readonly opts: BackendRouterOptions) {}

  private nameOf(turnId: string): BackendName {
    return turnId.slice(0, turnId.indexOf(":")) as BackendName;
  }

  private byTurn(turnId: string): BackendAdapter | undefined {
    return this.opts.backends[this.nameOf(turnId)];
  }

  /** 会话键 → 选择后端用的 scope：群与私聊即本身；owner 线程为首个 owner 账号的私聊（没有 owner 时退回本轮输入的 scope）。 */
  private threadScope(threadKey: ThreadKey, fallback: string): string {
    if (threadKey !== "owner") return threadKey;
    const owners = typeof this.opts.owners === "function" ? this.opts.owners() : this.opts.owners;
    const first = typeof owners === "string" ? owners : owners?.[0];
    return first ? `private:${first}` : fallback;
  }

  /**
   * 选定会话后端（宿主在开新回合前、可以切换时调用）：按会话键的设置选择；会话当前后端（current）在该会话仍忙
   * （pi 子 agent 在跑、run 未结束、codex 回合或子 agent 线程未结束）时仍用它。会话首次选定（没有 current）时，若某个后端在该会话
   * 已有工作（升级前遗留、先到的唤醒回合），也选它。busy 抛错即本次选择失败，宿主沿用当前后端。
   */
  async plan(threadKey: ThreadKey, input: InputRef, current?: string): Promise<string> {
    const [rec] = this.opts.turns.records([input]);
    const scope = this.threadScope(threadKey, rec!.scope);
    const wanted = this.opts.backendFor ? this.opts.backendFor(scope) : (await this.opts.settings(scope)).backend;
    const others = current !== undefined ? [current as BackendName]
      : (Object.keys(this.opts.backends) as BackendName[]).filter(name => name !== wanted);
    for (const name of others) {
      if (name !== wanted && await this.opts.backends[name]?.busy?.(threadKey)) {
        log.info("backend switch deferred; thread still busy on its backend", { thread: threadKey, backend: name, configured: wanted });
        return name;
      }
    }
    return wanted;
  }

  async startTurn(threadKey: ThreadKey, inputs: readonly InputRef[], ctx: TurnContext): Promise<StartTurnResult> {
    const now = this.opts.now ?? Date.now, deadline = now() + (this.opts.retryMs ?? 120_000);
    const { admit, backend: planned, ...turn } = ctx;
    for (let attempt = 1; ; attempt++) {
      try {
        // 定时输入：宿主在首次开轮前已复核；重试窗口可长达数分钟，每次重试前按当前授权再复核
        if (attempt > 1 && admit && !await admit()) return { denied: true };
        const records = this.opts.turns.records(inputs);
        const head = records[0]!;
        const scope = this.threadScope(threadKey, head.scope);
        const msg = {
          ticket: head.key, text: records.map(r => r.text).join("\n"),
          hasImages: records.some(r => r.images.length > 0), hasQuote: records.some(r => !!r.reply_to),
        };
        // 宿主已持久化本轮后端（plan）：按它执行，不按当前设置重新选择
        const settings = planned ? await this.opts.settings(scope, msg, planned as BackendName) : await this.opts.settings(scope, msg);
        const backend = this.opts.backends[settings.backend];
        if (!backend) throw new Error(`agent backend "${settings.backend}" is not registered`);
        trace.event("in:" + head.key, "admitted", { scope: head.scope, detail: { settings, thread_key: threadKey } });
        return await backend.startTurn(threadKey, inputs, turn, settings);
      } catch (error) {
        if (now() >= deadline) throw new UndeliverableError(error instanceof Error ? error.message : String(error));
        log.warn("start turn failed; retrying", { thread: threadKey, attempt, error });
        await new Promise(resolve => setTimeout(resolve, Math.min(this.opts.retryDelayMs ?? 5000 * attempt, Math.max(1, deadline - now()))));
      }
    }
  }

  async steer(threadKey: ThreadKey, turnId: string, input: InputRef): Promise<"ok" | "no_active_turn"> {
    return this.byTurn(turnId)?.steer(threadKey, turnId, input) ?? "no_active_turn";
  }

  async interrupt(threadKey: ThreadKey): Promise<void> {
    await Promise.all(Object.values(this.opts.backends).map(backend => backend?.interrupt(threadKey)));
  }

  async recoverTurn(threadKey: ThreadKey, turnId: string): Promise<"alive" | "lost"> {
    return this.byTurn(turnId)?.recoverTurn(threadKey, turnId) ?? "lost";
  }

  async abandon(threadKey: ThreadKey, turnId: string): Promise<TurnOutcome> {
    return await this.byTurn(turnId)?.abandon?.(threadKey, turnId) ?? { status: "completed" };
  }
}

export interface TurnMonitorOptions {
  inbox: {
    onDelivered(turnId: string, inputs: readonly InputRef[]): void;
    onDone(inputs: readonly InputRef[]): void;
    records(inputs: readonly Pick<InputRef, "inboundKey">[]): InboundRecord[];
    binding(threadKey: string): TurnBinding;
  };
  sendService?: Pick<SendService, "system" | "reconcile" | "cleanup">;
  scheduled?: {
    delivered(key: string, turnId: string): Promise<void>;
    finish(key: string, outcome: { status: TurnEnded["status"]; turnId?: string }): Promise<void>;
  };
  getHost(): Pick<ThreadHost, "stalled" | "interrupt">;
  now?: () => number;
  /** 同一会话出错提示的最小间隔，默认 10 分钟 */
  noticeIntervalMs?: number;
  stallMs?: number;
  watchdogIntervalMs?: number;
}

export class TurnMonitor {
  private readonly notified = new Map<string, number>();
  private readonly started = new Set<string>();
  /** 面板"停止"的会话：本次回合结束不发出错提示 */
  private readonly stopping = new Set<string>();
  private timer?: ReturnType<typeof setInterval>;
  private readonly pending = new Set<Promise<unknown>>();
  constructor(private readonly opts: TurnMonitorOptions) {}

  private get now() { return this.opts.now ?? Date.now; }

  private track(work: Promise<unknown>, label: string): void {
    const p = work.catch(error => log.warn(label, { error })).finally(() => this.pending.delete(p));
    this.pending.add(p);
  }

  /** 等待事件处理产生的异步工作（测试与关闭用）。 */
  async idle(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  readonly events: ThreadHostEvents = {
    inputsDelivered: (threadKey, turnId, inputs) => {
      this.opts.inbox.onDelivered(turnId, inputs);
      const records = this.opts.inbox.records(inputs);
      const first = !this.started.has(turnId);
      if (first) {
        this.started.add(turnId);
        const head = records[0];
        trace.event("turn:" + turnId, "received", { scope: head?.scope ?? "", detail: {
          text: records.map(r => r.text).join("\n"), sender: head?.nickname, thread_key: threadKey, kind: head?.kind,
          inputs: inputs.map(i => i.inboundKey) } });
      } else trace.event("turn:" + turnId, "steered", { detail: { inputs: inputs.map(i => i.inboundKey), text: records.map(r => r.text).join("\n") } });
      for (const rec of records) {
        if (rec.kind === "scheduled" && this.opts.scheduled) this.track(this.opts.scheduled.delivered(rec.key, turnId), "scheduled run delivery record failed");
      }
    },
    turnEnded: event => {
      this.opts.inbox.onDone(event.inputs);
      if (event.turnId) this.started.delete(event.turnId);
      const ok = event.status === "completed";
      const key = event.turnId ? "turn:" + event.turnId : "in:" + (event.inputs[0]?.inboundKey ?? "");
      trace.event(key, ok ? "reply_sent" : "failed", { status: ok ? "ok" : "failed", detail: {
        terminal: true, status: event.status, kind: event.kind, thread_key: event.threadKey, ...(event.error ? { reason: event.error } : {}),
        inputs: event.inputs.map(i => i.inboundKey) } });
      const stopped = this.stopping.delete(event.threadKey);
      if (!ok && !stopped && event.kind !== "scheduled") this.track(this.notice(event), "error notice failed");
      for (const input of event.inputs) {
        if (input.kind === "scheduled" && this.opts.scheduled) {
          this.track(this.opts.scheduled.finish(input.inboundKey, { status: event.status, ...(event.turnId ? { turnId: event.turnId } : {}) }), "scheduled run finish failed");
        }
      }
      if (this.opts.sendService) {
        const service = this.opts.sendService;
        this.track(service.reconcile().then(() => service.cleanup(event.threadKey)), "outbox maintenance failed");
      }
    },
  };

  /** 出错提示（§8.1）：同一会话 10 分钟内最多一条，作为系统消息经 Outbox 发出。 */
  private async notice(event: TurnEnded): Promise<void> {
    if (!this.opts.sendService) return;
    const last = this.notified.get(event.threadKey);
    if (last !== undefined && this.now() - last < (this.opts.noticeIntervalMs ?? 10 * 60_000)) return;
    this.notified.set(event.threadKey, this.now());
    const text = !event.turnId ? TURN_NOTICES.undeliverable : event.status === "lost" ? TURN_NOTICES.lost : TURN_NOTICES.failed;
    const [rec] = event.inputs.length ? this.opts.inbox.records([event.inputs.at(-1)!]) : [];
    const binding = rec ? { threadKey: event.threadKey, scope: rec.scope, inputKey: rec.key, ...(event.turnId ? { turnId: event.turnId } : {}) }
      : { ...this.opts.inbox.binding(event.threadKey), ...(event.turnId ? { turnId: event.turnId } : {}) };
    await this.opts.sendService.system(binding, text);
  }

  /** 面板"停止"：中止当前回合（连同子 agent），本次结束不发出错提示。 */
  async stop(threadKey: ThreadKey): Promise<void> {
    this.stopping.add(threadKey);
    await this.opts.getHost().interrupt(threadKey);
  }

  /** 看门狗（§8.2）：回合连续 30 分钟没有任何事件即中止；回合结束后按失败提示。 */
  async sweep(): Promise<ThreadKey[]> {
    const stalled = this.opts.getHost().stalled(this.now(), this.opts.stallMs ?? STALL_MS);
    for (const threadKey of stalled) {
      log.warn("turn stalled; interrupting", { thread: threadKey });
      trace.event("thr:" + threadKey, "stalled", { status: "failed", detail: { thread_key: threadKey } });
      await this.opts.getHost().interrupt(threadKey).catch(error => log.warn("interrupt stalled turn failed", { thread: threadKey, error }));
    }
    return stalled;
  }

  start(): void {
    this.timer ??= setInterval(() => { void this.sweep().catch(error => log.warn("watchdog sweep failed", { error })); }, this.opts.watchdogIntervalMs ?? 60_000);
    this.timer.unref();
  }

  stopWatchdog(): void { clearInterval(this.timer); this.timer = undefined; }
}
