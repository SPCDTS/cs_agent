import { Check } from 'typebox/value';
import type { AdminRoute } from './routes';
import { DeviceCreate, DeviceClaim } from '../devices/contracts';
import { DEVICE_CLIENT } from '../devices/client.generated';
import { readBounded, WebhookError } from '../github/model';

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
const id = '(?<id>[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})';
async function input(request: Request) {
  if (request.headers.has('origin')) throw new Error('device_pairing_denied');
  return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(await readBounded(request, 4096))) as unknown;
}
async function operation(work: () => Promise<unknown>) {
  try { return json(await work()); }
  catch (error) {
    const code = error instanceof Error && /^device_[a-z_]+$/.test(error.message) ? error.message : 'device_operation_failed';
    return json({ error: code }, error instanceof WebhookError ? error.status : code.endsWith('_denied') || code === 'device_already_claimed' ? 403 : 400);
  }
}
export const DEVICE_ROUTES: AdminRoute[] = [
  { method: 'GET', path: '/admin/device-client.cjs', public: true, handle: async () => new Response(DEVICE_CLIENT, { headers: {
    'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="cs-agent-device.cjs"', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff',
  } }) },
  { method: 'GET', path: '/admin/devices', handle: async ({ env }) => json(await env.REGISTRY.getByName('main').devicesList()) },
  { method: 'POST', path: '/admin/devices', handle: ({ env, request }) => operation(async () => {
    const value: unknown = JSON.parse(new TextDecoder().decode(await readBounded(request, 4096)));
    if (!Check(DeviceCreate, value)) throw new Error('device_invalid');
    return env.REGISTRY.getByName('main').deviceCreate(value);
  }) },
  { method: 'POST', path: new RegExp('^/admin/devices/' + id + '/pair$'), public: true, handle: ({ env, request, params }) => operation(async () => {
    const value = await input(request);
    if (!Check(DeviceClaim, value)) throw new Error('device_invalid');
    return env.REGISTRY.getByName('main').deviceClaim(params.id!, request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '', value.claim);
  }) },
  { method: 'POST', path: new RegExp('^/admin/devices/' + id + '/ready$'), public: true, handle: ({ env, request, params }) => operation(async () => {
    const value = await input(request);
    if (!Check(DeviceClaim, value)) throw new Error('device_invalid');
    const device = await env.REGISTRY.getByName('main').deviceReady(params.id!, request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '', value.claim);
    await env.THREAD.getByName('owner').recordMcpChange({ action: 'activate', server: device.serverId });
    await env.THREAD.getByName('owner').refreshMcp();
    return device;
  }) },
  { method: 'POST', path: new RegExp('^/admin/devices/' + id + '/revoke$'), handle: ({ env, params }) => operation(async () => {
    const device = await env.REGISTRY.getByName('main').deviceRevoke(params.id!);
    await env.THREAD.getByName('owner').recordMcpChange({ action: 'disable', server: device.serverId });
    return device;
  }) },
];
