import { Type, type Static } from 'typebox';
const strict = { additionalProperties: false };
export const DeviceId = Type.String({ pattern: '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' });
export const DeviceCreate = Type.Object({ id: DeviceId, name: Type.String({ minLength: 1, maxLength: 80 }), desktop: Type.Boolean() }, strict);
export const DeviceClaim = Type.Object({ claim: Type.String({ pattern: '^[a-f0-9]{64}$' }) }, strict);
export const DeviceView = Type.Object({ id: DeviceId, name: Type.String(), desktop: Type.Boolean(), state: Type.Union([
  Type.Literal('provisioning'), Type.Literal('pairing'), Type.Literal('ready'), Type.Literal('revoked'),
]), createdAt: Type.Number(), expiresAt: Type.Number(), serverId: Type.String(), desktopServerId: Type.Union([Type.String(), Type.Null()]) }, strict);
export const CloudflareStatus = Type.Object({ scopes: Type.Array(Type.String()), available: Type.Boolean(), domain: Type.Union([Type.String(), Type.Null()]), reauth: Type.Boolean() }, strict);
export const CloudflareLink = Type.Object({ url: Type.String() }, strict);
export const CloudflareCallback = Type.Object({ state: Type.String({ pattern: '^[A-Za-z0-9_-]{43}$' }), code: Type.String({ minLength: 1, maxLength: 8192 }) }, strict);
export const DnsName = Type.String({ maxLength: 253, pattern: '^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z][a-z0-9-]*$' });
export const CloudflareInventory = Type.Object({ resource: Type.Union([Type.Literal('dns'), Type.Literal('tunnels'), Type.Literal('workers'), Type.Literal('buckets')]) }, strict);
export const CloudflareChange = Type.Union([
  Type.Object({ action: Type.Literal('dns_create'), name: DnsName, type: Type.Union([Type.Literal('A'),Type.Literal('AAAA'),Type.Literal('CNAME')]),
    content: Type.String({ minLength: 1, maxLength: 253, pattern: '^[A-Za-z0-9.:-]+$' }), proxied: Type.Boolean() }, strict),
  Type.Object({ action: Type.Literal('cache_purge'), urls: Type.Array(Type.String({ minLength: 9, maxLength: 2048 }), { minItems: 1, maxItems: 10, uniqueItems: true }) }, strict),
  Type.Object({ action: Type.Literal('bucket_create'), name: Type.String({ pattern: '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$' }) }, strict),
]);
export type Change = Static<typeof CloudflareChange>;
export const CloudflareChangeList = Type.Array(Type.Object({ id: DeviceId, account: Type.String(), domain: Type.String(), change: CloudflareChange, expires: Type.Number(), status: Type.String() }, strict));
export const DeviceList = Type.Object({ configured: Type.Boolean(), cloudflare: Type.Optional(CloudflareStatus), devices: Type.Array(DeviceView) }, strict);
export const DeviceSetup = Type.Object({ device: DeviceView, pairingUrl: Type.String() }, strict);
