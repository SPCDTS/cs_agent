import { Check } from 'typebox/value';
import type { AdminRoute } from './routes';
import { API_HEADERS, adminJson as json, HttpError, readAdminJson } from './http';
import { CloudflareCallback, DeviceCreate, DeviceClaim } from '../devices/contracts';
import { DEVICE_CLIENT } from '../devices/client.generated';

const id = '(?<id>[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})';
async function input(request: Request) {
  if (request.headers.has('origin')) throw new Error('device_pairing_denied');
  return readAdminJson(request, { maxBytes: 4096, fatal: true });
}
async function operation(work: () => Promise<unknown>) {
  try { return json(await work()); }
  catch (error) {
    const code = error instanceof Error && /^device_[a-z_]+$/.test(error.message) ? error.message : 'device_operation_failed';
    return json({ error: code }, error instanceof HttpError ? error.status : code.endsWith('_denied') || code === 'device_already_claimed' ? 403 : 400);
  }
}
export const DEVICE_ROUTES: AdminRoute[] = [
  { method: 'GET', path: '/admin/device-client.cjs', public: true, handle: async () => new Response(DEVICE_CLIENT, { headers: {
    'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="cs-agent-device.cjs"', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff',
  } }) },
  { method: 'GET', path: '/admin/devices/cloudflare/changes', handle: ({ env }) => operation(() => env.REGISTRY.getByName('main').cloudflareChanges()) },
  { method: 'POST', path: new RegExp('^/admin/devices/cloudflare/changes/' + id + '/(?<decision>approve|reject)$'), handle: ({ env, params }) =>
    operation(() => env.REGISTRY.getByName('main').cloudflareReview(params.id!, params.decision === 'approve')) },
  { method: 'POST', path: '/admin/devices/cloudflare/start', handle: ({ env }) => operation(() => env.REGISTRY.getByName('main').cloudflareStart()) },
  { method: 'GET', path: '/admin/devices/cloudflare/callback', public: true, handle: async ({ url }) => {
    const state = url.searchParams.get('state'), code = url.searchParams.get('code');
    const result = Check(CloudflareCallback, { state, code }) && !url.searchParams.has('error')
      ? new URLSearchParams({ state: state!, code: code! }) : new URLSearchParams({ error: 'denied' });
    return new Response(null, { status: 303, headers: { ...API_HEADERS, Location: '/admin/#cloudflare?' + result } });
  } },
  { method: 'POST', path: '/admin/devices/cloudflare/complete', handle: ({ env, request }) => operation(async () => {
    const value = await readAdminJson(request, { maxBytes: 12000 });
    if (!Check(CloudflareCallback, value)) throw new Error('device_oauth_state');
    return env.REGISTRY.getByName('main').cloudflareComplete(value.state, value.code);
  }) },
  { method: 'GET', path: '/admin/devices', handle: async ({ env }) => json(await env.REGISTRY.getByName('main').devicesList()) },
  { method: 'POST', path: '/admin/devices', handle: ({ env, request }) => operation(async () => {
    const value = await readAdminJson(request, { maxBytes: 4096 });
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
