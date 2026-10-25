/** 实现后的接口索引；直接引用生产类型，避免设计草图与代码长期分叉。 */
export { PiMcp, isMcpToolName } from "../../../src/agent/pi-mcp/index.js";
export { loadMcpConfig, parseMcpConfig, DEFAULT_MCP_LIMITS } from "../../../src/agent/pi-mcp/config.js";
export type { McpConfig, McpConfigState, McpLimits, McpServerConfig, EnvironmentSecrets } from "../../../src/agent/pi-mcp/config.js";
export type { McpToolIdentity } from "../../../src/agent/pi-mcp/names.js";
export type { CatalogRevision } from "../../../src/agent/pi-mcp/catalog.js";

export type PiMcpOptions = Parameters<typeof import("../../../src/agent/pi-mcp/index.js").PiMcp.attach>[0];
