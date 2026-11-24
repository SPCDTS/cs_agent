import { Type, type Static } from 'typebox';
import { Check } from 'typebox/value';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const CUA_SERVER = 'cua';
export const cuaSpaceTools = ['list_spaces', 'list_tools', 'call_tool', 'space_bash', 'space_job'] as const;
export const cuaOwnerTools = ['create_space', 'delete_space'] as const;
export const cuaTools = [...cuaSpaceTools, ...cuaOwnerTools];
export const cuaReadOnly = ['list_spaces', 'list_tools'];
export const isCuaTargetTool = (server: string, name: string) =>
  server === CUA_SERVER && cuaSpaceTools.some(tool => tool === name);
export const SpaceId = Type.String({ minLength: 1, maxLength: 256, pattern: '^(relay:[a-z0-9-]{8,64}|(?:local|cloud):[a-zA-Z0-9_.-]+|direct:(?:[a-zA-Z0-9._-]+|\\[[0-9a-fA-F:]+\\]):[0-9]{1,5})$' });
const strings = Type.Array(Type.String());
const Space = Type.Object({
  id: Type.String(), name: Type.String(), display_name: Type.Optional(Type.String()),
  os: Type.Optional(Type.String()), phase: Type.Optional(Type.String()), status: Type.Optional(Type.String()),
  features: Type.Optional(strings), services: Type.Optional(strings),
});
export const SpaceCard = Type.Object({
  id: Type.String(), name: Type.String(), os: Type.String(), status: Type.String(), features: strings, services: strings,
});
export const SpaceDirectory = Type.Object({ configured: Type.Boolean(), spaces: Type.Array(SpaceCard) });
export type SpaceCard = Static<typeof SpaceCard>;

/** list_spaces 的正式契约是一个文本块，正文为 JSON 数组。只返回选定设备字段。 */
export function spaceCards(result: CallToolResult, allowed?: readonly string[]): SpaceCard[] {
  const first = result.content[0];
  if (result.isError || first?.type !== 'text') throw new Error('cua_directory_unavailable');
  const rows: unknown = JSON.parse(first.text);
  if (!Check(Type.Array(Space), rows)) throw new Error('cua_directory_invalid');
  return rows.filter(row => !allowed || allowed.includes(row.id)).map(row => ({
    id: row.id, name: row.display_name || row.name || row.id, os: row.os ?? '', status: row.status || row.phase || '',
    features: row.features ?? [], services: row.services ?? [],
  }));
}
