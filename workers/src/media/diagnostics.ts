import { SANDBOX_FAILURES } from "../sandbox/client";

/** 附件诊断只接受固定字段；不记录 URL、文件名、正文、请求/响应或原始异常。 */
export type MediaStage = "authorize" | "repository" | "recall" | "send" | "lookup" | "metadata" | "get_msg"
  | "resolve_url" | "get_file" | "get_image" | "get_record"
  | "download" | "store" | "asset_get" | "export" | "deliver" | "audit";
const codes = new Set([
  ...SANDBOX_FAILURES, "sandbox_not_found",
  "media_access_denied", "media_not_found", "media_scope_denied", "media_message_mismatch", "media_reference_missing",
  "media_url_missing", "media_url_unavailable", "media_url_denied", "media_dns_failed", "media_redirect_denied",
  "media_download_failed", "message_recalled", "invalid_media", "invalid_scope", "invalid_asset", "invalid_message_id",
  "invalid_media_reference", "napcat_image_content_missing", "invalid_image_content", "napcat_file_content_missing", "invalid_file_content",
  "asset_not_found", "asset_scope_denied", "asset_corrupt", "unsupported_image", "too_large",
  "permission_denied", "path_denied", "channel_down", "onebot_failed", "onebot_timeout", "onebot_disconnected",
]);
export type MediaErrorDetail = { code: string; errorType: string; status?: number; retcode?: number };
export function mediaErrorDetail(error: unknown): MediaErrorDetail {
  // RPC可能只保留message；兼容旧OneBot错误前缀，但绝不透传后面的文本。
  try {
    if (!(error instanceof Error)) return { code: "media_unknown_error", errorType: "unknown" };
    const errorType = ["Error", "TypeError", "SyntaxError", "RangeError", "AbortError", "TimeoutError", "MediaDownloadError"].includes(error.name) ? error.name : "Error";
    const code = codes.has(error.message) ? error.message
      : /^onebot_failed:/.test(error.message) ? "onebot_failed"
      : /^onebot_timeout:/.test(error.message) ? "onebot_timeout"
      : /^onebot_disconnected:/.test(error.message) ? "onebot_disconnected"
      : errorType === "TimeoutError" ? "media_timeout"
      : errorType === "AbortError" ? "media_aborted"
      : errorType === "SyntaxError" ? "media_invalid_json"
      : errorType === "TypeError" ? "media_type_error" : "media_unexpected_error";
    const status = code === "media_download_failed" ? (error as Error & { status?: unknown }).status : undefined;
    const match = /^onebot_failed:retcode=(-?\d{1,10})$/.exec(error.message), retcode = match ? Number(match[1]) : undefined;
    return { code, errorType, ...(retcode !== undefined && Math.abs(retcode) <= 2_147_483_647 ? { retcode } : {}), ...(typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599 ? { status } : {}) };
  } catch { return { code: "media_unknown_error", errorType: "unknown" }; }
}
export type MediaDiagnostic = {
  event: "media_stage"; traceId: string; scope: string; message_id?: string; ordinal?: number;
  stage: MediaStage; state: "start" | "success" | "failure"; ms: number;
  code?: string; errorType?: string; status?: number; retcode?: number;
};
export type MediaLog = (event: MediaDiagnostic) => void;
type TraceState = { traceId: string; scope: string; message_id?: string; failedStage?: MediaStage; failedOrdinal?: number };
export class MediaTrace {
  private readonly shared: TraceState;
  private readonly ordinal?: number;
  constructor(input: { messageId?: string; ordinal?: number } = {}, private readonly log: MediaLog = event => { if (event.state === "failure") console.warn(event); else console.info(event); }, shared?: TraceState) {
    this.shared = shared ?? { traceId: crypto.randomUUID(), scope: "unknown",
      ...(input.messageId === undefined ? {} : { message_id: /^-?\d{1,20}$/.test(input.messageId) ? input.messageId : "redacted" }) };
    this.ordinal = Number.isInteger(input.ordinal) && input.ordinal! >= 1 && input.ordinal! <= 100 ? input.ordinal : undefined;
  }
  get id(): string { return this.shared.traceId; }
  setScope(scope: string): void {
    this.shared.scope = /^(owner|(?:private|group):[1-9]\d{0,15})$/.test(scope) ? scope : "redacted";
  }
  forOrdinal(ordinal: number): MediaTrace { return new MediaTrace({ ordinal }, this.log, this.shared); }
  summary() {
    const { traceId, scope, message_id, failedStage } = this.shared;
    const ordinal = this.ordinal ?? this.shared.failedOrdinal;
    return { traceId, scope, ...(message_id === undefined ? {} : { message_id }),
      ...(ordinal === undefined ? {} : { ordinal }), ...(failedStage ? { failedStage } : {}) };
  }
  private emit(stage: MediaStage, state: MediaDiagnostic["state"], started: number, error?: MediaErrorDetail): void {
    // 故障观测本身绝不能改变业务结果，亦不允许sink修改共享上下文。
    const { failedStage: _failedStage, ...identity } = this.summary();
    try { this.log({ event: "media_stage", ...identity, stage, state, ms: Math.min(86_400_000, Math.max(0, Date.now() - started)), ...error }); } catch { /* best effort */ }
  }
  async run<T>(stage: MediaStage, work: () => Promise<T>): Promise<T> {
    const started = Date.now();
    this.emit(stage, "start", started);
    try {
      const result = await work();
      this.emit(stage, "success", started);
      return result;
    } catch (error) {
      if (stage !== "audit" && this.shared.failedStage === undefined) { this.shared.failedStage = stage; this.shared.failedOrdinal = this.ordinal; }
      this.emit(stage, "failure", started, mediaErrorDetail(error));
      throw error; // 保持原异常对象；日志只使用上面的白名单结构。
    }
  }
}
export function mediaStage<T>(trace: MediaTrace | undefined, stage: MediaStage, work: () => Promise<T>): Promise<T> {
  return trace ? trace.run(stage, work) : work();
}
