export type ErrorKind = "auth_missing" | "auth_invalid" | "unauthorized" | "permission" | "not_found" | "quota" | "upstream" | "network" | "response" | "input" | "storage" | "config";

export class GmailError extends Error {
  constructor(readonly kind: ErrorKind, message: string, readonly googleStatus?: number) { super(message); }
}

export const REAUTHORIZE = "Gmail 授权已失效，请在宿主机运行 npm run gmail:login 后重启 sidecar";

export function googleError(status: number): GmailError {
  switch (status) {
    case 401: return new GmailError("unauthorized", "Gmail 身份验证失败，请重新授权后重启 sidecar", status);
    case 403: return new GmailError("permission", "Gmail 权限不足，请检查授权范围与 Gmail API 是否启用", status);
    case 404: return new GmailError("not_found", "Gmail 邮件不存在", status);
    case 429: return new GmailError("quota", "Gmail 配额或请求频率超限，请稍后再试", status);
    default: return new GmailError("upstream", "Google 请求失败，请稍后再试", status);
  }
}

// 外部错误可能带请求地址、凭据或邮件内容，只允许固定分类文案穿过边界。
export function safeError(error: unknown): GmailError {
  return error instanceof GmailError ? error : new GmailError("upstream", "Gmail 操作失败，请检查 sidecar 状态");
}
