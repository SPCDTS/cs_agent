/**
 * codex 后端（设计 §4.4）：现有 CodexRunner 的适配。
 * - 线程：owner / shared（由请求的 threadKey 决定，同键串行）；
 * - 推理强度：固定 CODEX_REASONING_EFFORT（不再按请求选择）；
 * - 每轮注入：qq_context 的 QQ_ACCESS、image_gen 的 IMAGE_TICKET_DIR（${DATA_DIR}/images/<ticket>）；
 * - 输入：§3.2 的 [来源] / [引用] 头部 + 原文；
 * - 回合结束后收集票据图片目录里本回合新出现的图片（≤4，魔数检查）随文本返回。
 */
import { promises as fs } from "node:fs";
import { buildCodexPrompt, CodexTimeoutError, isReasoningEffort, type CodexRunner, type ReasoningEffort } from "../codex-runner.js";
import { collectNewImages, listFiles } from "../image-collect.js";
import { ticketImageDir } from "../image-gen.js";
import { log } from "../../log.js";
import { BackendTimeoutError, type AgentBackend, type AgentHandleContext, type AgentRequest, type AgentResponse } from "./types.js";

export interface CodexBackendOptions {
  runner: Pick<CodexRunner, "ask">;
  /** ${DATA_DIR}/images：票据图片目录的根（须与 image_gen MCP 的 ${DATA_DIR}/images 一致） */
  imagesDir: string;
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
    const dir = ticketImageDir(this.opts.imagesDir, req.ticket);
    await fs.mkdir(dir, { recursive: true });
    const before = await listFiles(dir);
    const prompt = buildCodexPrompt(req.source, req.text, {
      ...(req.time ? { time: req.time } : {}),
      ...(req.quote ? { quote: req.quote } : {}),
    });
    const started = Date.now();
    ctx.onEvent({ type: "codex_start", thread: req.threadKey, effort: this.effort ?? "default" });
    let text: string;
    try {
      text = await this.opts.runner.ask(prompt, {
        threadKey: req.threadKey,
        signal: ctx.signal,
        ...(this.effort ? { reasoningEffort: this.effort } : {}),
        qqAccess: req.access,
        imageTicketDir: dir,
      });
    } catch (err) {
      if (err instanceof CodexTimeoutError) throw new BackendTimeoutError(err.message);
      throw err;
    }
    const images = await collectNewImages(dir, before);
    log.info("codex backend done", {
      ticket: req.ticket.slice(0, 12),
      thread: req.threadKey,
      effort: this.effort ?? "default",
      ms: Date.now() - started,
      chars: text.length,
      images: images.length,
    });
    return { text, images };
  }
}

