/** 保留整个命名空间，历史目录损坏时仍能过滤子工具并保护审计正文。 */
export const isMcpToolName = (name: string): boolean => name.startsWith("mcp_");
export const MCP_CONTROL_EXTENSION = "cs.mcp.control";
export const isMcpExtensionName = (name: string): boolean => name.startsWith("cs.mcp.");

export interface McpToolIdentity {
  serverId: string;
  remoteName: string;
  nativeName: string;
  catalogDigest: string;
}
