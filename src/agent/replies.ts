/**
 * 出错提示（docs/ARCHITECTURE.md §3.4）：只在出错时向会话发一条系统消息，模型正常结束但没发消息时不提示。
 * failed：回合失败（模型/提供方报错、codex 超时、pi 回合 error、看门狗中止）；lost：后端崩溃导致回合丢失；
 * undeliverable：后端不可用超过 2 分钟，输入无法投递。
 */
export const TURN_NOTICES = {
  failed: "这次处理出错了，需要的话请再说一次。",
  lost: "处理中断了，需要的话请再说一次。",
  undeliverable: "现在暂时处理不了，请稍后再试。",
} as const;
