import { classifyFailure } from "../../shared/errors.js";
import { redactText } from "../../shared/redact.js";
import { trace } from "../../shared/trace.js";
import { CodexDeliveryNotes } from "../delivery-note.js";
import type { DeliveryNote } from "./types.js";
import { imageRefsValue, validateReferences } from "../../media/gen/image-references.js";
/**
 * codex 后端（设计 §4.4）：现有 CodexRunner 的适配。
 * - 线程：owner / group:<id> / private:<qq>（由请求的 threadKey 决定，同键串行）；
 * - 模型与推理强度：优先使用票据快照；旧票据沿用启动默认值；
 * - 每轮注入：qq_context 的 QQ_ACCESS、image_gen 的 IMAGE_TICKET_DIR（${DATA_DIR}/images/<ticket>）；
 * - 输入：§3.2 的 [来源] / [引用] 头部 + 原文；
 * - 回合结束后收集票据图片目录里本回合新出现的图片（≤4，魔数检查）随文本返回。
 *
 * 每张票据幂等（同一票据的回合最多真正执行一次，中断时最多再问一次）：
 * - codex 的 `-o` 最后一条消息固定写到 ${DATA_DIR}/tickets/<ticket>/codex-last.txt；
 * - 启动 codex 之前先经 ctx.persistTurn 把"回合已开始"（输出路径 + 次数）写进 TicketDoc；
 * - 再次进入（进程在回合结束后、结果提交前崩溃）：输出文件非空 → 直接当作本回合结果，不再询问；
 *   有"已开始"标记却没有输出 → 上一回合被中断（codex 可能已部分执行）：记 `codex turn interrupted`，
 *   最多再问一次（次数落盘），第二次中断后直接失败。
 * 票据工作目录在回复后由 agent 任务清理（图片目录另行管理）。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { buildCodexPrompt, CodexTimeoutError, isReasoningEffort, type CodexRunner } from "../codex/runner.js";
import { type ReasoningEffort } from "./types.js";
import { collectNewImages, listFiles } from "../../media/gen/image-collect.js";
import { ticketImageDir } from "../../media/gen/image-gen.js";
import { log } from "../../shared/log.js";
import { BackendTimeoutError, type AgentBackend, type AgentHandleContext, type AgentRequest, type AgentResponse } from "./types.js";

/** 票据工作目录里的 codex 最后一条消息文件名 */
export const CODEX_LAST_FILE = "codex-last.txt";
/** 同一票据最多启动 codex 回合的次数（首次 + 中断后重问 1 次） */
export const MAX_CODEX_TURNS = 2;

/**
 * 票据工作目录 ${ticketsDir}/<ticket>：非法字符替换为 _；解析后必须恰为 ticketsDir 的直接子目录。
 */
export function ticketWorkDir(ticketsDir: string, ticket: string): string {
  const seg = ticket.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 128);
  const root = path.resolve(ticketsDir);
  const dir = path.resolve(root, seg);
  if (!seg || path.relative(root, dir) !== seg) throw new Error(`非法的票据工作目录: ${ticket}`);
  return dir;
}

async function readNonEmpty(file: string): Promise<string | undefined> {
  const text = await fs.readFile(file, "utf8").catch(() => undefined);
  return text?.trim() ? text.trim() : undefined;
}

export interface CodexBackendOptions {
  runner: Pick<CodexRunner, "ask">;
  /** ${DATA_DIR}/images：票据图片目录的根（须与 image_gen MCP 的 ${DATA_DIR}/images 一致） */
  imagesDir: string;
  /** ${DATA_DIR}/tickets：票据工作目录的根（codex-last.txt） */
  ticketsDir: string;
  /** CODEX_REASONING_EFFORT；不在允许列表内时不传覆盖参数（沿用 config.toml）。函数形式每回合现读（运行时设置）。 */
  reasoningEffort?: string | (() => string | undefined);
}

export class CodexBackend implements AgentBackend {
  readonly name = "codex" as const;
  constructor(private readonly opts: CodexBackendOptions) {
    const initial = typeof opts.reasoningEffort === "function" ? opts.reasoningEffort() : opts.reasoningEffort;
    if (initial && !isReasoningEffort(initial)) {
      log.warn("CODEX_REASONING_EFFORT not in the allowed list; per-call override omitted", { value: initial });
    }
  }

  recordDeliveryNote(note: DeliveryNote): Promise<void> {
    return new CodexDeliveryNotes(path.dirname(this.opts.imagesDir)).record(note);
  }

  /** 本回合的推理强度（运行时设置可在两回合之间修改）。 */
  private get effort(): ReasoningEffort | undefined {
    const value = typeof this.opts.reasoningEffort === "function" ? this.opts.reasoningEffort() : this.opts.reasoningEffort;
    return isReasoningEffort(value) ? value : undefined;
  }

  async handle(req: AgentRequest, ctx: AgentHandleContext): Promise<AgentResponse> {
    const ticket = req.ticket.slice(0, 12);
    const dir = ticketImageDir(this.opts.imagesDir, req.ticket);
    await fs.mkdir(dir, { recursive: true });
    const workDir = ticketWorkDir(this.opts.ticketsDir, req.ticket);
    await fs.mkdir(workDir, { recursive: true });
    const outFile = path.join(workDir, CODEX_LAST_FILE);

    // 上次的回合已完成（输出已落盘）但结果没来得及提交：直接复用，不再询问
    const done = await readNonEmpty(outFile);
    if (done !== undefined) {
      const images = await collectNewImages(dir, new Set());
      log.warn("codex turn already completed before restart; reusing its output", { ticket, chars: done.length, images: images.length });
      trace.event(req.ticket, "recovered", { detail: { backend: "codex", reason: "saved_output" } });
      return { text: done, images };
    }
    const attempts = ctx.turn?.attempts ?? 0;
    if (attempts > 0) {
      log.warn("codex turn interrupted", { ticket, attempts, will_retry: attempts < MAX_CODEX_TURNS });
      if (attempts >= MAX_CODEX_TURNS) throw new Error(`codex turn interrupted ${attempts} times; not asking again`);
    }
    const before = await listFiles(dir);
    const refs = await validateReferences(req.images ?? [], req.images ?? [], path.join(path.dirname(this.opts.imagesDir), "incoming", req.ticket));
    imageRefsValue(refs);
    const prompt = buildCodexPrompt(req.source, req.text, {
      ...(req.time ? { time: req.time } : {}),
      ...(req.quote ? { quote: req.quote } : {}),
    });
    const effort = req.settings ? req.settings.codexReasoningEffort : this.effort;
    const started = Date.now();
    trace.event(req.ticket, "thread_wait", { status: "started", detail: { backend: "codex", thread_key: req.threadKey } });
    let modelStarted: number | undefined;
    let threadWaitMs: number | undefined;
    let text: string;
    try {
      text = await this.opts.runner.ask(prompt + (refs.length ? "\n[本轮参考图]\n" + refs.join("\n") : ""), {
        ticket: req.ticket,
        source: req.source, actor: req.actor, actorIsOwner: req.actorIsOwner,
        onJsonEvent: codexObserver(req.ticket),
        threadKey: req.threadKey,
        senderIsOwner: req.senderIsOwner === true,
        signal: ctx.signal,
        ...(req.settings?.codexModel !== undefined ? { model: req.settings.codexModel } : {}),
        ...(effort ? { reasoningEffort: effort } : {}),
        qqAccess: req.access,
        imageTicketDir: dir,
        imageRefs: refs,
        outputFile: outFile,
        onAcquired: async () => {
          modelStarted = Date.now(); threadWaitMs = modelStarted-started;
          trace.event(req.ticket,"thread_wait",{durationMs:threadWaitMs,detail:{backend:"codex",thread_wait_ms:threadWaitMs}});
          ctx.signal.throwIfAborted();
          await ctx.persistTurn?.({ outFile, attempts: attempts + 1 });
          trace.event(req.ticket, "model_turn", { status: "started", detail: { backend: "codex", thread_key: req.threadKey, effort, attempt: attempts + 1 } });
          ctx.onEvent({ type: "codex_start", thread: req.threadKey, effort: effort ?? "default", attempt: attempts + 1 });
        },
      });
    } catch (err) {
      trace.event(req.ticket, "model_turn", { status: "failed", durationMs: modelStarted === undefined ? undefined : Date.now()-modelStarted, detail: { backend: "codex", thread_key: req.threadKey, effort, thread_wait_ms: threadWaitMs ?? Date.now()-started, model_ms: modelStarted === undefined ? 0 : Date.now()-modelStarted, failure: classifyFailure(err,"codex"), error: err } });
      if (err instanceof CodexTimeoutError) throw new BackendTimeoutError(err.message);
      throw err;
    }
    trace.event(req.ticket, "model_turn", { durationMs: modelStarted === undefined ? undefined : Date.now()-modelStarted, detail: { backend: "codex", thread_wait_ms: threadWaitMs, model_ms: modelStarted === undefined ? 0 : Date.now()-modelStarted, thread_key: req.threadKey, effort, raw_reply: text } });
    // codex 没写 -o 文件（只从 JSONL 拿到文本）时补写：输出文件是"回合已完成"的唯一标志
    if ((await readNonEmpty(outFile)) === undefined) {
      const tmp = `${outFile}.${process.pid}.tmp`;
      await fs.writeFile(tmp, text);
      await fs.rename(tmp, outFile);
    }
    const images = await collectNewImages(dir, before);
    log.info("codex backend done", {
      ticket,
      thread: req.threadKey,
      effort: effort ?? "default",
      ms: Date.now() - started,
      chars: text.length,
      images: images.length,
    });
    return { text, images };
  }
}

/** JSONL 只提取白名单字段，不把原始事件（可能含凭据）存入观测库。 */
export function codexObserver(ticket: string): (event: Record<string, unknown>) => void {
  const starts = new Map<string, number>();
  let builtinCount = 0;
  return event => {
    const item = event.item as Record<string, unknown> | undefined;
    if (event.type === "thread.started") trace.event(ticket, "dispatched", { detail: { backend: "codex", thread_id: event.thread_id } });
    if (event.type === "turn.completed") {
      const usage = event.usage as Record<string,unknown> | undefined;
      // exec 的 usage 是线程累计计费量，不是本次请求的上下文占用。
      trace.event(ticket,"model_usage",{detail:{backend:"codex",total_input_tokens:usage?.input_tokens,total_output_tokens:usage?.output_tokens,total_cached_input_tokens:usage?.cached_input_tokens}});
    }
    if (event.type === "turn.failed" || event.type === "error") trace.event(ticket,"model_error",{status:"failed",detail:{backend:"codex",failure:classifyFailure(event.error ?? event.message,"codex")}});
    if (!item || !['mcp_tool_call','command_execution','web_search','web_search_call'].includes(String(item.type))) return;
    const id = String(item.id ?? item.tool ?? item.type).slice(0,128);
    if (event.type === "item.started" && starts.size < 200) starts.set(id, Date.now());
    const done = event.type === "item.completed";
    const duration = typeof item.duration_ms === "number" ? item.duration_ms : starts.has(id) ? Date.now() - starts.get(id)! : undefined;
    if (item.type !== 'mcp_tool_call') {
      const command = item.type === 'command_execution';
      const action = item.action as Record<string,unknown> | undefined;
      const summary = command ? {command:redactText(String(item.command ?? ''),200)} : {query:redactText(String(item.query ?? action?.query ?? ''),200)};
      if (event.type === 'item.started') {
        // 开始事件只给实时视图看"正在执行什么"；与完成事件共用 100 条上限。
        if (builtinCount < 100) trace.event(ticket,command ? 'tool:command_execution' : 'tool:web_search',{status:'started',detail:{backend:'codex',call_id:id,...summary}});
        return;
      }
      if (!done) return;
      starts.delete(id);
      if (builtinCount++ >= 100) return;
      trace.event(ticket,command ? 'tool:command_execution' : 'tool:web_search',{status:item.status==='failed' || (command && typeof item.exit_code==='number' && item.exit_code!==0) ? 'failed':'ok',durationMs:duration,
        detail:{backend:'codex',call_id:id,...summary,...(command ? {exit_code:typeof item.exit_code==='number' ? item.exit_code : null} : {})}});
      return;
    }
    if (!['item.started','item.updated','item.completed'].includes(String(event.type))) return;
    const failed = item.status === 'failed' || !!item.error;
    trace.event(ticket, "tool:" + String(item.tool ?? item.name ?? "unknown").slice(0,128), { status: done ? (failed ? "failed" : "ok") : "started",
      durationMs: done ? duration : undefined, detail: { backend: "codex", server: item.server, call_id: id, input: item.arguments, output: item.result, error: item.error,
        failure: failed ? classifyFailure(item.error,String(item.server ?? 'codex')) : undefined } });
    if (done) starts.delete(id);
  };
}
