import { Type, type Static } from 'typebox';

export const DesktopConfigSchema = Type.Object({
  host: Type.Literal('127.0.0.1'), port: Type.Integer({ minimum: 1, maximum: 65535 }),
  token: Type.String({ pattern: '^[a-f0-9]{64}$' }),
  command: Type.String({ minLength: 1 }), args: Type.Array(Type.String(), { maxItems: 32 }),
  scopeArgument: Type.Optional(Type.String({ pattern: '^--[a-z][a-z0-9-]*$' })),
  cwd: Type.String({ minLength: 1 }), desktopSid: Type.String({ pattern: '^S-1-[0-9-]+$' }),
}, { additionalProperties: false });
export type DesktopConfig = Static<typeof DesktopConfigSchema>;
export const DesktopContextSchema = Type.Object({ stamp: Type.String({ minLength: 1, maxLength: 500 }), sessionId: Type.Integer({ minimum: 1 }) }, { additionalProperties: false });
