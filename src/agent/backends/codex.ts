/**
 * codex 后端（设计 §4.4）：现有 CodexRunner 的适配。
 * - 线程：owner / shared（由请求的 threadKey 决定，同键串行）；
 * - 推理强度：固定 CODEX_REASONING_EFFORT（不再按请求选择）；
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
import { buildCodexPrompt, CodexTimeoutError, isReasoningEffort, type CodexRunner, type ReasoningEffort } from "../codex-runner.js";
import { collectNewImages, listFiles } from "../image-collect.js";
import { ticketImageDir } from "../image-gen.js";
import { log } from "../../log.js";
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
  /** CODEX_REASONING_EFFORT；不在允许列表内时不传覆盖参数（沿用 config.toml） */
  reasoningEffort?: string;
}

export class CodexBackend implements AgentBackend {
  readonly name = "codex" as const;
  private readonly effort: ReasoningEffort | undefined;

  constructor(private readonly opts: CodexBackendOptions) {
    this.effort = isReasoningEffort(opts.reasoningEffort) ? opts.reasoningEffort : undefined;
    if (opts.reasoningEffort && !this.effort) {
      log.warn("CODEX_REASONING_EFFORT not in the allowed list; per-call override omitted", { value: opts.reasoningEffort });
    }
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
      return { text: done, images };
    }
    const attempts = ctx.turn?.attempts ?? 0;
    if (attempts > 0) {
      log.warn("codex turn interrupted", { ticket, attempts, will_retry: attempts < MAX_CODEX_TURNS });
      if (attempts >= MAX_CODEX_TURNS) throw new Error(`codex turn interrupted ${attempts} times; not asking again`);
    }
    // 启动 codex 之前先持久化"回合已开始"
    await ctx.persistTurn?.({ outFile, attempts: attempts + 1 });

    const before = await listFiles(dir);
    const prompt = buildCodexPrompt(req.source, req.text, {
      ...(req.time ? { time: req.time } : {}),
      ...(req.quote ? { quote: req.quote } : {}),
    });
    const started = Date.now();
    ctx.onEvent({ type: "codex_start", thread: req.threadKey, effort: this.effort ?? "default", attempt: attempts + 1 });
    let text: string;
    try {
      text = await this.opts.runner.ask(prompt, {
        threadKey: req.threadKey,
        signal: ctx.signal,
        ...(this.effort ? { reasoningEffort: this.effort } : {}),
        qqAccess: req.access,
        imageTicketDir: dir,
        outputFile: outFile,
      });
    } catch (err) {
      if (err instanceof CodexTimeoutError) throw new BackendTimeoutError(err.message);
      throw err;
    }
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
      effort: this.effort ?? "default",
      ms: Date.now() - started,
      chars: text.length,
      images: images.length,
    });
    return { text, images };
  }
}
