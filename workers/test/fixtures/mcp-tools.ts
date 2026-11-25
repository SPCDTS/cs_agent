import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export const sampleTools: Tool[] = [
  { name: "notion-search", description: "搜索资料", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false } },
  { name: "notion-fetch", inputSchema: { type: "object", properties: {} } },
  { name: "notion-create-pages", inputSchema: { type: "object", properties: { bad: { type: "string", secretKeyword: true } } } },
  { name: "not-allowed", inputSchema: { type: "object" } },
];
