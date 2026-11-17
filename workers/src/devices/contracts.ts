import { Type } from 'typebox';
const strict = { additionalProperties: false };
export const DeviceId = Type.String({ pattern: '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' });
export const DeviceCreate = Type.Object({ id: DeviceId, name: Type.String({ minLength: 1, maxLength: 80 }), desktop: Type.Boolean() }, strict);
export const DeviceClaim = Type.Object({ claim: Type.String({ pattern: '^[a-f0-9]{64}$' }) }, strict);
export const DeviceView = Type.Object({ id: DeviceId, name: Type.String(), desktop: Type.Boolean(), state: Type.Union([
  Type.Literal('provisioning'), Type.Literal('pairing'), Type.Literal('ready'), Type.Literal('revoked'),
]), createdAt: Type.Number(), expiresAt: Type.Number(), serverId: Type.String(), desktopServerId: Type.Union([Type.String(), Type.Null()]) }, strict);
export const DeviceList = Type.Object({ configured: Type.Boolean(), devices: Type.Array(DeviceView) }, strict);
export const DeviceSetup = Type.Object({ device: DeviceView, pairingUrl: Type.String() }, strict);
