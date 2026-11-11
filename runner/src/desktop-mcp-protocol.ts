import { Type, type Static } from 'typebox';

const strict = { additionalProperties: false };
export const DesktopMcpOperationSchema = Type.Union([
  Type.Object({ kind: Type.Literal('list') }, strict),
  Type.Object({ kind: Type.Literal('call'), name: Type.String({ minLength: 1, maxLength: 128 }), arguments: Type.Record(Type.String(), Type.Unknown()) }, strict),
]);
export type DesktopMcpOperation = Static<typeof DesktopMcpOperationSchema>;
export const DesktopMcpRequestSchema = Type.Object({
  token: Type.String({ minLength: 64, maxLength: 64 }), scope: Type.String({ pattern: '^[a-f0-9]{64}$' }),
  deadline: Type.Number(), operation: DesktopMcpOperationSchema,
}, strict);
export const DesktopMcpSettingsSchema = Type.Object({
  pipeName: Type.String({ pattern: '^cs-agent-desktop-[a-f0-9]{32}$' }), token: Type.String({ pattern: '^[a-f0-9]{64}$' }),
  command: Type.String({ minLength: 1 }), args: Type.Array(Type.String(), { maxItems: 32 }),
  scopeArgument: Type.Optional(Type.String({ pattern: '^--[a-z][a-z0-9-]*$' })),
  cwd: Type.String({ minLength: 1 }), desktopSid: Type.String({ pattern: '^S-1-[0-9-]+$' }),
}, strict);
export type DesktopMcpSettings = Static<typeof DesktopMcpSettingsSchema>;
export const DesktopContextSchema = Type.Object({ stamp: Type.String({ minLength: 1, maxLength: 500 }), sessionId: Type.Integer({ minimum: 1 }) }, strict);
export const DESKTOP_MCP_REQUEST_BYTES = 512 * 1024;
export const DESKTOP_MCP_RESULT_BYTES = 12 * 1024 * 1024;
