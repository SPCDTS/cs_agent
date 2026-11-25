import { Check } from 'typebox/value';
import type { AdminRoute } from './routes';
import { API_HEADERS, adminJson as json, HttpError, readAdminJson } from './http';
import { CloudflareCallback } from '../cloudflare/contracts';

const id = '(?<id>[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})';
// 保留已发布的账户管理 API 以及 OAuth 客户端登记的回调地址。
const accountPath = (suffix: string) => new RegExp('^/admin/(?:devices/)?cloudflare/' + suffix + '$');
async function operation(work: () => Promise<unknown>) {
  try { return json(await work()); }
  catch (error) {
    const code = error instanceof Error && /^device_[a-z_]+$/.test(error.message) ? error.message : 'device_operation_failed';
    return json({ error: code }, error instanceof HttpError ? error.status : code.endsWith('_denied') ? 403 : 400);
  }
}
export const CLOUDFLARE_ROUTES: AdminRoute[] = [
  { method: 'GET', path: '/admin/cloudflare', handle: async ({ env }) => json(await env.REGISTRY.getByName('main').cloudflareStatus()) },
  { method: 'GET', path: accountPath('changes'), handle: ({ env }) => operation(() => env.REGISTRY.getByName('main').cloudflareChanges()) },
  { method: 'POST', path: accountPath('changes/' + id + '/(?<decision>approve|reject)'), handle: ({ env, params }) =>
    operation(() => env.REGISTRY.getByName('main').cloudflareReview(params.id!, params.decision === 'approve')) },
  { method: 'POST', path: accountPath('start'), handle: ({ env }) => operation(() => env.REGISTRY.getByName('main').cloudflareStart()) },
  { method: 'GET', path: '/admin/devices/cloudflare/callback', public: true, handle: async ({ url }) => {
    const state = url.searchParams.get('state'), code = url.searchParams.get('code');
    const result = Check(CloudflareCallback, { state, code }) && !url.searchParams.has('error')
      ? new URLSearchParams({ state: state!, code: code! }) : new URLSearchParams({ error: 'denied' });
    return new Response(null, { status: 303, headers: { ...API_HEADERS, Location: '/admin/#cloudflare?' + result } });
  } },
  { method: 'POST', path: accountPath('complete'), handle: ({ env, request }) => operation(async () => {
    const value = await readAdminJson(request, { maxBytes: 12000 });
    if (!Check(CloudflareCallback, value)) throw new Error('device_oauth_state');
    return env.REGISTRY.getByName('main').cloudflareComplete(value.state, value.code);
  }) },
];
