/**
 * 出站发送规则的公共契约（设计 DESIGN-resident-agent §9）：限额由面板设置提供，执行在通道实现内。
 * 会话 scope 为 group:<id> / private:<qq>，全局熔断的 scope 为 global。
 */
export interface SendRuleLimits {
  /** 每会话每分钟最多条数；超出拒绝本条 */
  perChatMinute: number;
  /** 每会话每小时最多条数；超出熔断该会话 */
  perChatHour: number;
  chatBreakerMinutes: number;
  /** 全局每分钟最多条数；超出熔断全部受规则约束的发送 */
  globalMinute: number;
  globalBreakerMinutes: number;
}

export const DEFAULT_SEND_RULES: Readonly<SendRuleLimits> = Object.freeze({
  perChatMinute: 6, perChatHour: 60, chatBreakerMinutes: 60, globalMinute: 30, globalBreakerMinutes: 10,
});

export const GLOBAL_SEND_SCOPE = "global";

export interface SendBreaker { scope: string; until: number; tripped_at: number; reason: string }

/** 被发送规则拒绝；message 原样返回给模型。tripped 表示本次拒绝刚刚触发熔断。 */
export class SendRuleError extends Error {
  override readonly name = "SendRuleError";
  constructor(message: string, readonly rule: "chat_minute" | "chat_hour" | "global_minute" | "breaker",
    readonly scope: string, readonly tripped?: SendBreaker) { super(message); }
}

export function isSendRuleError(error: unknown): error is SendRuleError {
  return error instanceof Error && error.name === "SendRuleError";
}
