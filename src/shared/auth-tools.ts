/** 模型工具名与内部授权操作分开；回环端点和面板继续使用内部操作名。 */
export const AUTH_TOOLS = ["auth"] as const;
export const AUTH_ACTIONS = ["grant", "revoke", "list"] as const;
export type AuthOperation = `auth_${typeof AUTH_ACTIONS[number]}`;
