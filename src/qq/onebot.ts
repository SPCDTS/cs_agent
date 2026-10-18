/**
 * OneBot v11 HTTP 客户端：POST <httpUrl>/<action>，Bearer 鉴权，超时中止。
 * 发送类调用（sending=true）的任何失败都标记为 uncertain：消息可能已发出，禁止自动重试。
 */

const ID_PATTERN = /^[1-9]\d{0,15}$/;

/** QQ 号 / 群号是否为合法的正整数字符串（且在安全整数范围内）。 */
export function isValidId(value: string): boolean {
  return ID_PATTERN.test(value) && Number.isSafeInteger(Number(value));
}

/** 校验并转为 OneBot 需要的数字形式。 */
export function numericId(value: string): number {
  if (typeof value !== "string" || !isValidId(value)) {
    throw new Error("QQ 号或群号必须是有效的正整数字符串。");
  }
  return Number(value);
}

export class OneBotError extends Error {
  /** true 表示发送结果不确定：可能已经发出，不要重试。 */
  readonly uncertain: boolean;
  constructor(message: string, uncertain: boolean) {
    super(message);
    this.name = "OneBotError";
    this.uncertain = uncertain;
  }
}

interface CallOptions {
  /** 是否为发送消息类调用（失败即 uncertain） */
  sending?: boolean;
  /** 覆盖默认超时 */
  timeoutMs?: number;
}

export interface OneBotClient {
  call(action: string, params?: Record<string, unknown>, options?: CallOptions): Promise<unknown>;
}

const UNCERTAIN_HINT = "；消息可能已经发出，不要重试，请先查看聊天记录确认。";

export function createOneBotClient(httpUrl: string, token: string, defaultTimeoutMs: number): OneBotClient {
  const base = httpUrl.replace(/\/+$/, "");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = "Bearer " + token;

  async function call(action: string, params: Record<string, unknown> = {}, options: CallOptions = {}): Promise<unknown> {
    const sending = options.sending === true;
    const fail = (message: string): never => {
      throw new OneBotError(message + (sending ? UNCERTAIN_HINT : ""), sending);
    };

    let response: Response | undefined;
    try {
      response = await fetch(base + "/" + action, {
        method: "POST",
        headers,
        body: JSON.stringify(params),
        redirect: "error",
        signal: AbortSignal.timeout(options.timeoutMs ?? defaultTimeoutMs),
      });
    } catch {
      fail("无法连接 NapCat HTTP 服务或请求超时（" + action + "）");
    }
    if (!response) return fail("NapCat HTTP 无响应（" + action + "）");
    if (!response.ok) fail("NapCat HTTP " + response.status + "（" + action + "）；401/403 通常表示 Token 不匹配");

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      fail("NapCat 返回格式错误（" + action + "）");
    }
    if (!isRecord(body) || body.status !== "ok" || body.retcode !== 0) {
      const retcode = isRecord(body) ? String(body.retcode) : "?";
      fail("NapCat 操作 " + action + " 未成功，retcode=" + retcode);
    }
    return (body as Record<string, unknown>).data;
  }

  return { call };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 从 OneBot data 中取出 message_id / user_id 之类字段，统一为字符串。 */
export function stringField(data: unknown, key: string): string {
  if (!isRecord(data)) return "";
  const value = data[key];
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}
