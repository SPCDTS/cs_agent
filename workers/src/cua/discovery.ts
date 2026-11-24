import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ToolExecutionResult } from '@earendil-works/pi-durable';
import { Type } from 'typebox';
import { Check } from 'typebox/value';
import type { McpAuthority } from '../mcp/access';
import type { McpLimits } from '../mcp/config';
import { boundedJson } from '../mcp/schema';
import { mcpFailure } from '../mcp/result';
import { MediaRepository } from '../media/repository';
import type { Env } from '../env';
import { Card, CuaDeviceId, CuaScope, cuaCards } from './contracts';

export const cuaDirectoryTools = ['list_spaces', 'list_tools'] as const;
export function isCuaInspection(name: string) { return name === 'get_hostname' || name === 'get_window_screenshot'; }
export function isCuaTool(name: string) { return isCuaInspection(name) || cuaDirectoryTools.some(tool => tool === name); }
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
const hostnameQuery = Type.Object({space:CuaDeviceId}, {additionalProperties:false});
const windowNumber = Type.Integer({minimum:1, maximum:0xffffffff});
const windowQuery = Type.Object({space:CuaDeviceId, pid:windowNumber, window_id:windowNumber}, {additionalProperties:false});
// undefined 表示主人可浏览整个目录；空数组表示没有设备。
export function cuaQueryAllowed(tool: string, args: unknown, spaces?: readonly string[]) {
  if (spaces?.length === 0) return false;
  if (tool === 'get_hostname') return spaces === undefined && Check(hostnameQuery,args);
  if (tool === 'get_window_screenshot') return spaces === undefined && Check(windowQuery,args);
  if (tool === 'list_spaces') return Check(Type.Object({}, {additionalProperties:false}), args);
  return tool === 'list_tools' && Check(toolQuery, args) && (!spaces || spaces.includes(args.space));
}
const toolList = Type.Array(Type.Object({
  name:Type.String(), description:Type.String(), inputSchema:Type.Optional(Type.Record(Type.String(), Type.Unknown())),
}));
const driverDirectory = Type.Object({service:Type.Literal('driver'), tools:toolList});
const spacesOutput = Type.Object({spaces:Type.Array(Card)});
const toolsOutput = Type.Object({tools:toolList});
const hostnameOutput = Type.Object({hostname:Type.String()});
export function cuaOutput(server:string, name:string) {
  if (server !== 'cua') return;
  if (name === 'list_spaces') return spacesOutput;
  if (name === 'list_tools') return toolsOutput;
  if (name === 'get_hostname') return hostnameOutput;
  if (name === 'get_window_screenshot') return Type.Object({imageId:Type.String({pattern:'^[a-f0-9]{64}$'})});
}
export async function cuaResult(tool: string, remote: CallToolResult, spaces: string[] | undefined, limits: McpLimits,
  env: Env, scope: string): Promise<ToolExecutionResult> {
  if (remote.isError) return mcpFailure('cua_unavailable');
  try {
    if (isCuaInspection(tool)) {
      const block = remote.content[0];
      if (remote.content.length !== 1 || spaces !== undefined) return mcpFailure('cua_result_invalid');
      if (tool === 'get_hostname') {
        if (block?.type !== 'text' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,252}$/.test(block.text)) return mcpFailure('cua_result_invalid');
        return {structuredOutput:{hostname:block.text}, output:[{type:'text',text:block.text}]};
      }
      // 只交付桥返回的单张 PNG，不把上游窗口标题、辅助功能树或截图元数据带入会话。
      if (block?.type !== 'image' || block.mimeType !== 'image/png' || block.data.length > Math.min(limits.messageBytes, 4 * 1024 * 1024)
          || !block.data.startsWith('iVBORw0KGgo') || block.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(block.data)) return mcpFailure('cua_result_invalid');
      const bytes = Buffer.from(block.data,'base64');
      if (bytes.length < 33 || bytes.toString('ascii',12,16) !== 'IHDR') return mcpFailure('cua_result_invalid');
      const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
      if (!width || !height || width > 768 || height > 768) return mcpFailure('cua_result_invalid');
      const asset = await new MediaRepository({bucket:env.ASSETS,scope}).put({bytes, kind:'image', mime:'image/png', name:'window.png'});
      return {structuredOutput:{imageId:asset.id}, output:[{type:'image',mimeType:'image/png',data:block.data}]};
    }
    let directory;
    if (tool === 'list_spaces') directory = {spaces:cuaCards(remote,spaces)};
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
