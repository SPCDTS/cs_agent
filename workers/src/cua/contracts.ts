import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { Type, type Static } from 'typebox';
import { Check } from 'typebox/value';

export const CuaBridgeToken = Type.String({ minLength:32, maxLength:256, pattern:'^[A-Za-z0-9._~-]+$' });
export const CuaSetupInput = Type.Object({ token:CuaBridgeToken }, {additionalProperties:false});
export const CuaScope = Type.String({pattern:'^(group|private):[1-9][0-9]{0,19}$'});
export const CuaDeviceId = Type.String({maxLength:256,
  pattern:'^(?:relay:[a-z0-9][a-z0-9-]{6,62}[a-z0-9]|direct:(?:[a-zA-Z0-9._-]+|\\[[0-9a-fA-F:]+\\]):[0-9]{1,5})$'});
export const CuaGrantInput = Type.Object({
  scope:CuaScope, spaces:Type.Array(CuaDeviceId, {uniqueItems:true, maxItems:64}), expectedRevision:Type.String({minLength:1,maxLength:64}),
}, {additionalProperties:false});
export type CuaGrantInput = Static<typeof CuaGrantInput>;
export const CuaDeviceGrantInput = Type.Object({
  space:CuaDeviceId, scopes:Type.Array(CuaScope, {uniqueItems:true, maxItems:256}), expectedRevision:Type.String({minLength:1,maxLength:64}),
}, {additionalProperties:false});
export type CuaDeviceGrantInput = Static<typeof CuaDeviceGrantInput>;
const displayName = Type.String({maxLength:64,pattern:'^[^\\u0000-\\u001f\\u007f-\\u009f\\u2028-\\u202e\\u2066-\\u2069]*$'});
export const CuaNameInput = Type.Object({
  space:CuaDeviceId, name:displayName, expectedName:displayName, expectedRevision:Type.String({minLength:1,maxLength:64}),
}, {additionalProperties:false});
export type CuaNameInput = Static<typeof CuaNameInput>;
export const CuaNameResult = Type.Object({name:displayName});
const Grant = Type.Object({scope:CuaScope, spaces:Type.Array(CuaDeviceId)});
export const CuaGrantList = Type.Object({revision:Type.String(), grants:Type.Array(Grant)});
export type CuaGrantList = Static<typeof CuaGrantList>;
export const Card = Type.Object({id:Type.String(), name:Type.String(), os:Type.String(), status:Type.String()});
export type CuaCard = Static<typeof Card>;
export function deviceAlias(names: Record<string,string>, id: string): string | undefined {
  if (Object.hasOwn(names,id)) return names[id];
}
export const CuaDirectory = Type.Object({
  setup:Type.Optional(Type.Union([Type.Literal('new'),Type.Literal('pending'),Type.Literal('managed')])),
  bridgeUrl:Type.Optional(Type.String()),
  configured:Type.Boolean(), online:Type.Boolean(), enabled:Type.Boolean(), available:Type.Boolean(),
  error:Type.Optional(Type.Literal('directory_unavailable')),
  tools:Type.Optional(Type.Array(Type.String())),
  revision:Type.String(), devices:Type.Array(Type.Object({...Card.properties, defaultName:Type.Optional(Type.String()), alias:Type.Optional(displayName), scopes:Type.Array(CuaScope)})),
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
    if (!allowed || allowed.includes(row.id)) cards.push({id:row.id, name:row.name || row.display_name || row.id,
      os:row.os ?? '', status:row.status || row.power_state || row.phase || ''});
  }
  return cards;
}
