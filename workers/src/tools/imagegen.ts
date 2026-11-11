import { Buffer } from "node:buffer";
import type { Context } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai/models";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { defineTool, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { CODEX_BASE_URL, CODEX_PROVIDER } from "../codex-login";
import { responseDiagnostic } from "../codex-refresh-error";
import { FILE_MAX_BYTES } from "../media/model";
import type { MediaRepository } from "../media/repository";

export const ImageParameters = Type.Object({
  prompt: Type.String({ minLength: 1, description: "完整的绘图或修改要求。不要包含登录凭据。" }),
  images: Type.Optional(Type.Array(Type.String({ pattern: "^[a-f0-9]{64}$" }), { description: "编辑时填写本会话已有图片资产 ID，可来自 qq_image 或上次生成结果；不接受 URL。" })),
  size: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("1024x1024"), Type.Literal("1536x1024"), Type.Literal("1024x1536")])),
  quality: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")])),
  background: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("opaque"), Type.Literal("transparent")])),
  output_format: Type.Optional(Type.Union([Type.Literal("png"), Type.Literal("jpeg"), Type.Literal("webp")])),
}, { additionalProperties: false });
type ImageOptions = Static<typeof ImageParameters>;
const ImageResponse = Type.Object({ data: Type.Array(Type.Object({ b64_json: Type.String({ minLength: 1 }) }), { minItems: 1, maxItems: 1 }) });
const ERRORS = {
  login_required: "请在管理页完成 Codex 原生登录；旧的 ChatGPT 授权不支持订阅生图。",
  auth_failed: "Codex 授权不可用，请在管理页检查授权状态。",
  unauthorized: "Codex 生图授权已失效，请重新登录。",
  forbidden: "Codex 拒绝了生图请求，请检查账号生图权限或地区限制。",
  rate_limit: "Codex 生图额度或请求频率受限，请稍后再试或检查订阅用量。",
  upstream: "Codex 生图请求失败。",
  response: "Codex 返回的图片数据无效。",
  asset: "参考图片不可读，请使用当前会话内有效的图片资产 ID。",
  too_large: "图片超出当前媒体资产的 10MiB 大小限制。",
  invalid_request: "生图要求不能为空；透明背景请使用 PNG 或 WebP。",
  timeout: "生图等待超时，上游可能仍已消耗额度；请勿自动重复生成。",
  aborted: "生图已中断，上游结果未确认；请勿自动重复生成。",
  network: "生图连接中断，上游结果未确认；请勿自动重复生成。",
  storage: "图片已生成但保存失败；请勿自动重新生成。",
};
type ImageErrorCode = keyof typeof ERRORS;
export class ImageGenerationError extends Error {
  constructor(readonly code: ImageErrorCode, readonly diagnostic?: ReturnType<typeof responseDiagnostic>) { super(ERRORS[code]); }
}
// 在读取 JSON 时计量，限制的是既有单资产上限加 Base64/JSON 开销，避免耗尽 Worker 内存。
async function imageResponse(response: Response): Promise<Static<typeof ImageResponse>> {
  if (!response.body) throw new ImageGenerationError("response");
  const limit = Math.ceil(FILE_MAX_BYTES / 3) * 4 + 64 * 1024;
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let size = 0, json = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit) { await reader.cancel(); throw new ImageGenerationError("too_large"); }
      json += decoder.decode(chunk.value, { stream: true });
    }
    json += decoder.decode();
  } finally { reader.releaseLock(); }
  let value: unknown;
  try { value = JSON.parse(json); } catch { throw new ImageGenerationError("response"); }
  if (!Check(ImageResponse, value)) throw new ImageGenerationError("response");
  return value;
}

export async function generateImage(options: ImageOptions, deps: { models: Pick<Models, "getAuth">; repository: MediaRepository; signal?: AbortSignal; operationId: string }) {
  if (!options.prompt.trim() || options.background === "transparent" && options.output_format === "jpeg") throw new ImageGenerationError("invalid_request");
  const auth = await deps.models.getAuth(CODEX_PROVIDER).catch(() => { throw new ImageGenerationError("auth_failed"); });
  if (!auth?.auth.apiKey || auth.auth.baseUrl !== CODEX_BASE_URL) throw new ImageGenerationError("login_required");
  const images: { image_url: string }[] = [];
  let inputBytes = 0;
  for (const id of options.images ?? []) {
    const image = await deps.repository.get(id).catch(() => { throw new ImageGenerationError("asset"); });
    if (image.ref.kind !== "image") throw new ImageGenerationError("asset");
    inputBytes += image.bytes.byteLength;
    if (inputBytes > FILE_MAX_BYTES) throw new ImageGenerationError("too_large");
    images.push({ image_url: "data:" + image.ref.mime + ";base64," + Buffer.from(image.bytes).toString("base64") });
  }
  const deadline = AbortSignal.timeout(300_000), signal = deps.signal ? AbortSignal.any([deps.signal, deadline]) : deadline;
  try {
    const headers = new Headers(Object.entries(auth.auth.headers ?? {}).flatMap(([key, value]) => typeof value === "string" ? [[key, value]] : []));
    headers.set("Authorization", "Bearer " + auth.auth.apiKey);
    headers.set("Content-Type", "application/json");
    headers.set("Accept", "application/json");
    headers.set("x-codex-imagegen-request-id", deps.operationId);
    headers.set("x-codex-image-turn-id", deps.operationId);
    const { images: _references, ...parameters } = options;
    // 与 Magpie 相同的 Codex 专用图片接口；不发送到公开计费 API，不自动重试。
    const response = await fetch(CODEX_BASE_URL + (images.length ? "/images/edits" : "/images/generations"), {
      method: "POST", redirect: "manual", headers, signal,
      body: JSON.stringify({ ...parameters, model: "gpt-image-2", n: 1, output_format: options.output_format ?? "png", ...(images.length ? { images } : {}) }),
    });
    if (!response.ok) {
      const diagnostic = responseDiagnostic(response);
      await response.body?.cancel();
      throw new ImageGenerationError(response.status === 401 ? "unauthorized" : response.status === 403 ? "forbidden"
        : response.status === 429 ? "rate_limit" : "upstream", diagnostic);
    }
    const data = await imageResponse(response), encoded = data.data[0]!.b64_json;
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) throw new ImageGenerationError("response");
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.byteLength > FILE_MAX_BYTES) throw new ImageGenerationError("too_large");
    const ref = await deps.repository.put({ bytes, kind: "image", name: "generated." + (options.output_format ?? "png") })
      .catch(error => { throw new ImageGenerationError(error instanceof Error && error.message === "unsupported_image" ? "response" : "storage"); });
    return { ref };
  } catch (error) {
    if (error instanceof ImageGenerationError) throw error;
    throw new ImageGenerationError(deps.signal?.aborted ? "aborted" : deadline.aborted ? "timeout" : "network");
  }
}

export function createImageTool(deps: {
  models: Pick<Models, "getAuth">;
  repository: MediaRepository;
  allowed(api: ToolExecutionApi, context: Context): Promise<boolean>;
  record(detail: object): Promise<unknown>;
}) {
  // 审计故障不能把已经落库的图片变成失败，诱发模型重新生成。
  const record = (detail: object) => deps.record(detail).catch(() => { console.error({ event: "image_audit_failed" }); });
  return defineTool({
    name: "generate_image", replay: "unsafe", parameters: ImageParameters,
    description: "使用已登录的 Codex / ChatGPT 订阅生成一张图片，或按图片资产 ID 编辑图片；DeepSeek 与 GPT 均可调用。需要用户明确要求生成或修改图片。结果已存为本会话私有图片资产；用 send_message 的 images 发送返回的资产 ID，网页回合仅展示网页。中断后不要自动重试。",
    execute: async (options, api, context) => {
      if (!await deps.allowed(api, context)) return { isError: true, output: [{ type: "text", text: "本回合无权生成图片。" }] };
      const start = Date.now();
      try {
        const operationId = await api.memo("cs.image.request-id", crypto.randomUUID(), context);
        const image = await generateImage(options, { ...deps, signal: context.abortSignal, operationId });
        await record({ result: "ok", ms: Date.now() - start, assets: [image.ref.id], mode: options.images?.length ? "edit" : "generate" });
        // 原图留在 R2；对话只持久化引用，避免每轮重复存储或发送大段 Base64。
        return { output: [{ type: "text", text: JSON.stringify({ image: image.ref, send: { images: [image.ref.id] } }) }] };
      } catch (error) {
        const failure = error instanceof ImageGenerationError ? error : new ImageGenerationError("storage");
        await record({ result: failure.code, ms: Date.now() - start, ...failure.diagnostic });
        return { isError: true, output: [{ type: "text", text: failure.code + "：" + failure.message }] };
      }
    },
  });
}
