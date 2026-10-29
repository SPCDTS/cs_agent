import type { Context } from "@earendil-works/chord/context";
import { Type, type Models } from "@earendil-works/pi-ai";
import { defineTool, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { HostedToolError, runHostedTool, type HostedFailure, type ImageSize } from "../codex-hosted";

export const IMAGE_TIMEOUT_MS = 180_000;
/** 面板显示的图片生成状态，取最近一次真实调用的结果。 */
export type ImageAvailability = "unknown" | "available" | "unavailable";
export type ImageOutcome = "ok" | HostedFailure;
// 只有成功与后端明确拒绝能说明订阅能不能用；超时、没出图等不改变已知状态。
export const availabilityOf = (outcome: ImageOutcome): Exclude<ImageAvailability, "unknown"> | undefined =>
  outcome === "ok" ? "available" : outcome === "rejected" ? "unavailable" : undefined;

const FAILURES: Partial<Record<HostedFailure, string>> = {
  rejected: "image_generation_unavailable：ChatGPT 后端拒绝了图片生成，当前订阅可能不支持。",
  login_required: "login_required：主人尚未登录 ChatGPT，无法生成图片。",
  no_image: "no_image：模型没有生成图片，可以换个描述再试。",
  timeout: "timeout：图片生成超时，请稍后再试。",
};

/** 与联网搜索同一种独立请求，只是托管工具换成 image_generation；图片在输出项 image_generation_call.result 里（base64 PNG）。 */
export async function codexImage(models: Models, prompt: string, size: ImageSize, options: { signal?: AbortSignal; modelId?: string }): Promise<string> {
  const { calls } = await runHostedTool(models, `调用 image_generation 工具生成一张图片，只生成图片，不要回复文字。图片描述：${prompt}`,
    { type: "image_generation", size, quality: "medium" }, { ...options, timeoutMs: IMAGE_TIMEOUT_MS });
  const image = calls.map(call => call.result).find((result): result is string => typeof result === "string" && result.length > 0);
  if (!image) throw new HostedToolError("no_image");
  return image;
}

export type ImageToolDeps = {
  /** 只有 owner 亲自发来的消息回合可以生成；定时与事件回合都不行。 */
  allowed(api: ToolExecutionApi, context: Context): Promise<boolean>;
  generate(prompt: string, size: ImageSize, signal?: AbortSignal): Promise<string>;
  /** 发到本回合所在会话，结果与 send_message 同形。 */
  deliver(api: ToolExecutionApi, context: Context, base64: string): Promise<object>;
  record(outcome: ImageOutcome, ms: number): Promise<unknown>;
};

export function createGenerateImageTool(deps: ImageToolDeps) {
  return defineTool({
    name: "generate_image", description: "按描述生成一张图片（经 ChatGPT 订阅）并直接发到本会话；只有主人亲自发消息时可用。成功后不用再描述图片，按需补一句话即可。",
    parameters: Type.Object({
      prompt: Type.String({ minLength: 1, maxLength: 4000 }),
      size: Type.Optional(Type.Union([Type.Literal("1024x1024"), Type.Literal("1024x1536"), Type.Literal("1536x1024")])),
    }, { additionalProperties: false }),
    // 生成要花订阅额度，成功后还会发 QQ，中断后不自动重放。
    replay: "unsafe",
    execute: async ({ prompt, size }, api, context) => {
      if (!await deps.allowed(api, context)) {
        return { isError: true, output: [{ type: "text", text: "只有主人亲自发消息的回合可以生成图片；本回合请先告诉主人。" }] };
      }
      const started = Date.now();
      let image: string;
      try { image = await deps.generate(prompt, size ?? "1024x1024", context.abortSignal); }
      catch (error) {
        const code: HostedFailure = error instanceof HostedToolError ? error.code : "upstream";
        await deps.record(code, Date.now() - started);
        return { isError: true, output: [{ type: "text", text: FAILURES[code] ?? `${code}：图片生成暂时不可用，请稍后再试。` }] };
      }
      await deps.record("ok", Date.now() - started);
      return { output: [{ type: "text", text: JSON.stringify(await deps.deliver(api, context, image)) }] };
    },
  });
}
