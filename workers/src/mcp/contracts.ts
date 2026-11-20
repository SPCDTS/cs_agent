import type { McpGrant, McpGrantInput, McpApproval } from './policy';

/** MCP 管理域的 RPC 契约；写操作走执行对象，只读走 AgentReadView。 */
export type McpReviewResult = {status:string;result?:{isError?:boolean;output:({type:"text";text:string}|{type:"image";data:string;mimeType:string})[]}};
export interface McpAdminRpc {
 mcpSetAccess(scope: string, server: string, input: McpGrantInput, expected: string): Promise<McpGrant>;
 mcpReviewApproval(scope: string, id: string, decision: "approve" | "reject"): Promise<McpReviewResult>;
}
export interface McpReadRpc {
 mcpAccess(scope: string, server: string): Promise<McpGrant | null>;
 mcpApprovals(scope: string): Promise<McpApproval[]>;
}
