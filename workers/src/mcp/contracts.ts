import type { McpGrant, McpGrantInput, McpApproval } from './policy';

/** MCP 管理域的 RPC 契约；HTTP 路由和执行对象共同依赖此处。 */
export type McpReviewResult = {status:string;result?:{isError?:boolean;output:({type:"text";text:string}|{type:"image";data:string;mimeType:string})[]}};
export interface McpAdminRpc {
 mcpAccess(scope: string, server: string): Promise<McpGrant | null>;
 mcpSetAccess(scope: string, server: string, input: McpGrantInput, expected: string): Promise<McpGrant>;
 mcpApprovals(scope: string): Promise<McpApproval[]>;
 mcpReviewApproval(scope: string, id: string, decision: "approve" | "reject"): Promise<McpReviewResult>;
}
