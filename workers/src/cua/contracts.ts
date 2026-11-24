import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { Type, type Static } from 'typebox';
import { Check } from 'typebox/value';

export const CuaScope = Type.String({pattern:'^(group|private):[1-9][0-9]{0,19}$'});
export const CuaDeviceId = Type.String({maxLength:256,
  pattern:'^(?:relay:[a-z0-9][a-z0-9-]{6,62}[a-z0-9]|direct:(?:[a-zA-Z0-9._-]+|\\[[0-9a-fA-F:]+\\]):[0-9]{1,5})$'});
export const CuaGrantInput = Type.Object({
  scope:CuaScope, spaces:Type.Array(CuaDeviceId, {uniqueItems:true, maxItems:64}), expectedRevision:Type.String({minLength:1,maxLength:64}),
}, {additionalProperties:false});
export type CuaGrantInput = Static<typeof CuaGrantInput>;
const Grant = Type.Object({scope:CuaScope, spaces:Type.Array(CuaDeviceId)});
export const CuaGrantList = Type.Object({revision:Type.String(), grants:Type.Array(Grant)});
export type CuaGrantList = Static<typeof CuaGrantList>;
export const Card = Type.Object({id:Type.String(), name:Type.String(), os:Type.String(), status:Type.String()});
export type CuaCard = Static<typeof Card>;
export const CuaDirectory = Type.Object({
  configured:Type.Boolean(), online:Type.Boolean(), enabled:Type.Boolean(), available:Type.Boolean(),
  error:Type.Optional(Type.Literal('directory_unavailable')),
  revision:Type.String(), devices:Type.Array(Type.Object({...Card.properties, scopes:Type.Array(CuaScope)})),
  grants:Type.Array(Grant), threads:Type.Array(Type.Object({key:CuaScope, name:Type.Optional(Type.String())})),
});
export type CuaDirectory = Static<typeof CuaDirectory>;

const RawCard = Type.Object({
  id:Type.String({minLength:1,maxLength:256}), name:Type.String(), display_name:Type.Optional(Type.String()),
  os:Type.Optional(Type.String()), phase:Type.Optional(Type.String()), power_state:Type.Optional(Type.String()), status:Type.Optional(Type.String()),
});

/** Cua 0.31 通过单个文本块返回 JSON 数组。拒绝含歧义 ID 的目录；仅投递用于选机的字段。 */
export function cuaCards(result: CallToolResult, allowed?: readonly string[]): CuaCard[] {
  const block = result.content[0];
  if (result.isError || result.content.length !== 1 || block?.type !== 'text') throw new Error('cua_directory_invalid');
  const rows: unknown = JSON.parse(block.text);
  if (!Check(Type.Array(RawCard), rows)) throw new Error('cua_directory_invalid');
  const seen = new Set<string>();
  const cards: CuaCard[] = [];
  for (const row of rows) {
    if (seen.has(row.id)) throw new Error('cua_directory_ambiguous');
    seen.add(row.id);
    if (!allowed || allowed.includes(row.id)) cards.push({id:row.id, name:row.display_name || row.name || row.id,
      os:row.os ?? '', status:row.status || row.power_state || row.phase || ''});
  }
  return cards;
}
