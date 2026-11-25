import { copyJson } from '@earendil-works/chord/json';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ToolExecutionResult } from '@earendil-works/pi-durable';
import { Type } from 'typebox';
import { Check } from 'typebox/value';
import type { McpAuthority } from '../mcp/access';
import type { McpLimits } from '../mcp/config';
import { boundedJson } from '../mcp/schema';
import { boundedMcpText, convertMcpResult, mcpFailure } from '../mcp/result';
import { imageMime } from '../media/model';
import { MediaRepository } from '../media/repository';
import type { Env } from '../env';
import { Card, CuaDeviceId, CuaScope, cuaCards, deviceAlias } from './contracts';

export const cuaTools = ['list_spaces', 'list_tools', 'space_bash', 'space_job', 'space_write', 'call_tool'] as const;
const CUA_DRIVER_READ_ONLY_TOOLS = new Set([
  'list_windows', 'list_apps', 'list_sessions',
  'get_window_state', 'get_desktop_state', 'get_browser_state',
  'get_screen_size', 'get_cursor_position', 'get_accessibility_tree',
  'get_config', 'get_session', 'get_guide',
  'get_agent_cursor_state', 'get_recording_state',
  'clipboard_read', 'parse_visual_regions', 'verify_state', 'zoom',
  'debug_window_info', 'health_report', 'check_for_update',
]);
export function isCuaDeviceOperation(name: string) {
  return name === 'space_bash' || name === 'space_job' || name === 'space_write' || name === 'call_tool';
}
export function isCuaTool(name: string) { return cuaTools.some(tool => tool === name); }
export function isCuaReadOnlyTool(name: string) {
  return name === 'list_spaces' || name === 'list_tools';
}
export function cuaCallIsReadOnly(name: string, args: Record<string, unknown>) {
  if (isCuaReadOnlyTool(name)) return true;
  if (name === 'space_job') return args.action === 'list' || args.action === 'status' || args.action === 'logs';
  if (name === 'call_tool') {
    if (typeof args.tool !== 'string') return false;
    if (CUA_DRIVER_READ_ONLY_TOOLS.has(args.tool)) return true;
    // check_permissions 默认会弹出系统授权对话框，仅明确传 prompt=false 时才是纯只读查询。
    return args.tool === 'check_permissions' && isPlainRecord(args.arguments) && args.arguments.prompt === false;
  }
  return false;
}
export function cuaSubject(a: McpAuthority) {
  if (a.kind === 'agent' || a.kind === 'event' || (a.kind === 'subagent' && !a.subagentId)) return false;
  return (a.scope === 'owner' ? a.owner : Check(CuaScope, a.scope));
}
export const CuaSnapshot = Type.Object({
  revision: Type.String(), spaces: Type.Array(Type.String({minLength:1, maxLength:256}), {maxItems:1024}),
  grants: Type.Optional(Type.Record(CuaDeviceId,Type.String({pattern:'^[a-f0-9]{32}$'}),{maxProperties:64})),
});
const toolQuery = Type.Object({
  space: CuaDeviceId, service: Type.Literal('driver'), name: Type.Optional(Type.String({maxLength:128})),
}, {additionalProperties:false});
const bashQuery = Type.Object({
  space: CuaDeviceId, command: Type.String({minLength:1, maxLength:32768}),
  timeout: Type.Optional(Type.Integer({minimum:1, maximum:50})),
}, {additionalProperties:false});
const writeQuery = Type.Object({
  space: CuaDeviceId, path: Type.String({minLength:1, maxLength:4096}), content: Type.String({maxLength:262144}),
}, {additionalProperties:false});
const driverCallQuery = Type.Object({
  space: CuaDeviceId, service: Type.Literal('driver'),
  tool: Type.String({minLength:1, maxLength:128, pattern:'^[a-zA-Z0-9_.-]+$'}),
  arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
}, {additionalProperties:false});
const jobId = Type.String({minLength:1, maxLength:128, pattern:'^[A-Za-z0-9._-]+$'});
const jobListQuery = Type.Object({space:CuaDeviceId, action:Type.Literal('list')}, {additionalProperties:false});
const jobTargetQuery = Type.Object({
  space: CuaDeviceId, action:Type.Union([Type.Literal('status'), Type.Literal('cancel')]), job:jobId,
}, {additionalProperties:false});
const jobLogsQuery = Type.Object({
  space: CuaDeviceId, action:Type.Literal('logs'), job:jobId,
  offset: Type.Optional(Type.Integer({minimum:0, maximum:Number.MAX_SAFE_INTEGER})),
  limit: Type.Optional(Type.Integer({minimum:1, maximum:262144})),
  follow_ms: Type.Optional(Type.Integer({minimum:0, maximum:25000})),
}, {additionalProperties:false});
const jobUntil = Type.Object({
  file: Type.Optional(Type.String({minLength:1, maxLength:4096})),
  port: Type.Optional(Type.Integer({minimum:1, maximum:65535})),
  host: Type.Optional(Type.String({minLength:1, maxLength:253})),
  command: Type.Optional(Type.String({minLength:1, maxLength:32768})),
  pr_checks: Type.Optional(Type.String({minLength:1, maxLength:256})),
  interval: Type.Optional(Type.Integer({minimum:1, maximum:300})),
}, {additionalProperties:false});
const jobStartQuery = Type.Object({
  space: CuaDeviceId, action:Type.Literal('start'),
  command: Type.Optional(Type.String({minLength:1, maxLength:32768})),
  until: Type.Optional(jobUntil),
  name: Type.Optional(Type.String({minLength:1, maxLength:80})),
  cwd: Type.Optional(Type.String({minLength:1, maxLength:4096})),
  env: Type.Optional(Type.Record(Type.String(), Type.String({maxLength:4096}), {maxProperties:64})),
  timeout: Type.Optional(Type.Integer({minimum:1, maximum:86400})),
}, {additionalProperties:false});
const envKeyPattern = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function validJobStart(args: Record<string, unknown>): boolean {
  if (!Check(jobStartQuery, args)) return false;
  if ((args.command !== undefined) === (args.until !== undefined)) return false;
  if (typeof args.command === 'string' && args.command.includes('\0')) return false;
  if (typeof args.name === 'string' && /[\r\n\0]/.test(args.name)) return false;
  if (typeof args.cwd === 'string' && args.cwd.includes('\0')) return false;
  if (args.until !== undefined) {
    const u = args.until;
    const conds = (['file', 'port', 'command', 'pr_checks'] as const).filter(key => u[key] !== undefined);
    if (conds.length !== 1) return false;
    if (typeof u.file === 'string' && u.file.includes('\0')) return false;
    if (typeof u.command === 'string' && u.command.includes('\0')) return false;
    if (typeof u.pr_checks === 'string' && u.pr_checks.includes('\0')) return false;
    if (u.host !== undefined && (u.port === undefined || /[\s\0]/.test(u.host))) return false;
  }
  if (args.env !== undefined) {
    for (const [k, v] of Object.entries(args.env)) {
      if (!envKeyPattern.test(k) || v.includes('\0')) return false;
    }
  }
  return true;
}
function validSpaceJob(args: unknown): args is { space: string; action: string } {
  if (!isPlainRecord(args)) return false;
  if (args.action === 'list') return Check(jobListQuery, args);
  if (args.action === 'status' || args.action === 'cancel') return Check(jobTargetQuery, args);
  if (args.action === 'logs') return Check(jobLogsQuery, args);
  if (args.action === 'start') return validJobStart(args);
  return false;
}
// undefined 表示主人可浏览整个目录；空数组表示没有设备。
export function cuaQueryAllowed(tool: string, args: unknown, spaces?: readonly string[]) {
  if (spaces?.length === 0) return false;
  if (tool === 'list_spaces') return Check(Type.Object({}, {additionalProperties:false}), args);
  let valid = false;
  if (tool === 'list_tools') valid = Check(toolQuery, args);
  else if (tool === 'space_bash') valid = Check(bashQuery, args) && !args.command.includes('\0');
  else if (tool === 'space_write') valid = Check(writeQuery, args) && !args.path.includes('\0') && Buffer.byteLength(args.content, 'utf8') <= 256 * 1024;
  else if (tool === 'space_job') valid = validSpaceJob(args);
  else if (tool === 'call_tool') valid = Check(driverCallQuery, args) && (args.arguments === undefined || isPlainRecord(args.arguments));
  if (!valid || !isPlainRecord(args) || typeof args.space !== 'string') return false;
  return !spaces || spaces.includes(args.space);
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
export async function cuaResult(tool: string, args: Record<string,unknown>, remote: CallToolResult, spaces: string[] | undefined, limits: McpLimits,
  env: Env, scope: string, revision: string): Promise<ToolExecutionResult> {
  try {
    if (isCuaDeviceOperation(tool)) {
      const converted = convertMcpResult(remote, undefined, limits);
      if (remote.isError || converted.isError) return converted;
      if (tool === 'space_job' && converted.structuredOutput === undefined) {
        const block = remote.content[0];
        if (remote.content.length === 1 && block?.type === 'text' && block.text.trimStart().startsWith('{')) {
          try {
            const parsed: unknown = JSON.parse(block.text);
            if (isPlainRecord(parsed)) {
              return { ...converted, structuredOutput: copyJson(boundedJson(parsed, limits.structuredBytes, limits.schemaDepth * 3 + 3)) };
            }
          } catch { /* 非 JSON 文本保留原输出 */ }
        }
        return converted;
      }
      if (tool === 'call_tool' && converted.output) {
        const nextOutput: NonNullable<ToolExecutionResult['output']> = [];
        const imageIds: string[] = [];
        let invalidImages = 0;
        const media = new MediaRepository({ bucket: env.ASSETS, scope });
        const label = typeof args.tool === 'string' ? args.tool : 'screenshot';
        for (const part of converted.output) {
          if (part.type !== 'image') { nextOutput.push(part); continue; }
          const raw = Buffer.from(part.data, 'base64');
          const detected = imageMime(raw);
          const pngOk = detected !== 'image/png' || (raw.length >= 33 && raw.toString('ascii', 12, 16) === 'IHDR');
          if (!raw.length || !detected || detected !== part.mimeType || raw.toString('base64') !== part.data || !pngOk) {
            invalidImages++;
            continue;
          }
          const ext = detected.split('/')[1] ?? 'png';
          const asset = await media.put({ bytes: raw, kind: 'image', mime: detected, name: `${label}.${ext}` });
          imageIds.push(asset.id);
          nextOutput.push(part);
        }
        if (invalidImages && !imageIds.length && remote.content.every(part => part.type === 'image') && converted.structuredOutput === undefined) {
          return mcpFailure('cua_result_invalid');
        }
        if (invalidImages || imageIds.length) {
          const notes: string[] = [];
          if (invalidImages) notes.push('[Cua 图片内容无效，已省略]');
          if (imageIds.length === 1) notes.push(`[已保存截图 imageId: ${imageIds[0]}（可用于 send_message.images）]`);
          else if (imageIds.length > 1) notes.push(`[已保存截图 imageIds: ${JSON.stringify(imageIds)}]`);
          const suffix = notes.join('\n');
          const firstText = nextOutput.find(part => part.type === 'text');
          if (firstText && firstText.type === 'text') {
            if (!firstText.text) firstText.text = boundedMcpText(suffix);
            else if (firstText.text.length + 1 + suffix.length <= 8000) firstText.text = `${firstText.text}\n${suffix}`;
            else firstText.text = boundedMcpText(firstText.text.slice(0, Math.max(0, 7960 - suffix.length)).replace(/[\uD800-\uDBFF]$/, '')) + '\n' + suffix;
          } else {
            nextOutput.unshift({ type: 'text', text: boundedMcpText(suffix) });
          }
        }
        let structuredOutput = converted.structuredOutput;
        if (imageIds.length) {
          const merged = { ...(isPlainRecord(structuredOutput) ? structuredOutput : {}), imageIds, ...(imageIds.length === 1 ? { imageId: imageIds[0] } : {}) };
          structuredOutput = copyJson(boundedJson(merged, limits.structuredBytes, limits.schemaDepth * 3 + 3));
        }
        return { output: nextOutput, ...(structuredOutput === undefined ? {} : { structuredOutput }) };
      }
      return converted;
    }
    if (remote.isError) return mcpFailure('cua_unavailable');
    let directory;
    if (tool === 'list_spaces') {
      const cards = cuaCards(remote,spaces);
      const names: Record<string,string> = await env.REGISTRY.getByName('main').cuaNames(cards.map(card => card.id),revision);
      directory = {spaces:cards.map(card => ({...card,name:deviceAlias(names,card.id) ?? card.name}))};
    }
    else {
      const block = remote.content[0];
      if (remote.content.length !== 1 || block?.type !== 'text') return mcpFailure('cua_directory_invalid');
      const data:unknown = JSON.parse(block.text);
      if (!Check(driverDirectory,data)) return mcpFailure('cua_directory_invalid');
      directory = {tools:data.tools.map(({name,description,inputSchema}) => ({name,description,...(inputSchema ? {inputSchema} : {})}))};
    }
    const structuredOutput = boundedJson(directory,limits.structuredBytes,limits.schemaDepth * 3 + 3);
    return {structuredOutput, output:[{type:'text',text: tool === 'list_spaces' ? '设备卡见 structuredContent.spaces。' : 'Driver 工具目录见 structuredContent.tools。'}]};
  } catch { return mcpFailure(isCuaDeviceOperation(tool) ? 'cua_result_invalid' : 'cua_directory_invalid_or_too_large'); }
}
