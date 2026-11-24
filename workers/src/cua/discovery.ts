import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ToolExecutionResult } from '@earendil-works/pi-durable';
import { Type } from 'typebox';
import { Check } from 'typebox/value';
import type { McpAuthority } from '../mcp/access';
import type { McpLimits } from '../mcp/config';
import { boundedJson } from '../mcp/schema';
import { mcpFailure } from '../mcp/result';
import { Card, CuaDeviceId, CuaScope, cuaCards } from './contracts';

export const cuaTools = ['list_spaces', 'list_tools'] as const;
export function isCuaTool(name: string) { return cuaTools.some(tool => tool === name); }
export function cuaSubject(a: McpAuthority) {
  if (a.kind === 'agent' || a.kind === 'event' || (a.kind === 'subagent' && !a.subagentId)) return false;
  return (a.scope === 'owner' ? a.owner : Check(CuaScope, a.scope));
}
export const CuaSnapshot = Type.Object({
  revision: Type.String(), spaces: Type.Array(Type.String({minLength:1, maxLength:256}), {maxItems:1024}),
});
const toolQuery = Type.Object({
  space: CuaDeviceId, service: Type.Literal('driver'), name: Type.Optional(Type.String({maxLength:128})),
}, {additionalProperties:false});
// undefined 表示主人可浏览整个目录；空数组表示没有设备。
export function cuaQueryAllowed(tool: string, args: unknown, spaces?: readonly string[]) {
  if (spaces?.length === 0) return false;
  if (tool === 'list_spaces') return Check(Type.Object({}, {additionalProperties:false}), args);
  return tool === 'list_tools' && Check(toolQuery, args) && (!spaces || spaces.includes(args.space));
}
const toolList = Type.Array(Type.Object({
  name:Type.String(), description:Type.String(), inputSchema:Type.Optional(Type.Record(Type.String(), Type.Unknown())),
}));
const driverDirectory = Type.Object({service:Type.Literal('driver'), tools:toolList});
const spacesOutput = Type.Object({spaces:Type.Array(Card)});
const toolsOutput = Type.Object({tools:toolList});
export function cuaOutput(server:string, name:string) {
  if (server !== 'cua') return;
  if (name === 'list_spaces') return spacesOutput;
  if (name === 'list_tools') return toolsOutput;
}
export function cuaResult(tool: string, remote: CallToolResult, spaces: string[] | undefined, limits: McpLimits): ToolExecutionResult {
  if (remote.isError) return mcpFailure('cua_unavailable');
  try {
    let directory;
    if (tool === 'list_spaces') directory = {spaces:cuaCards(remote, spaces)};
    else {
      const block = remote.content[0];
      if (remote.content.length !== 1 || block?.type !== 'text') return mcpFailure('cua_directory_invalid');
      const data:unknown = JSON.parse(block.text);
      if (!Check(driverDirectory,data)) return mcpFailure('cua_directory_invalid');
      directory = {tools:data.tools.map(({name,description,inputSchema}) => ({name,description,...(inputSchema ? {inputSchema} : {})}))};
    }
    const structuredOutput = boundedJson(directory,limits.structuredBytes,limits.schemaDepth * 3 + 3);
    return {structuredOutput, output:[{type:'text',text: tool === 'list_spaces' ? '设备卡见 structuredContent.spaces。' : 'Driver 工具目录见 structuredContent.tools。'}]};
  } catch { return mcpFailure('cua_directory_invalid_or_too_large'); }
}
