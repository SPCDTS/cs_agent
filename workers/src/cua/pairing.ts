import { createHmac, randomUUID } from 'node:crypto';
import { Check } from 'typebox/value';
import { Type } from 'typebox';
import { adminJson, API_HEADERS, HttpError } from '../admin/http';
import { CUA_MAC_JOIN, CUA_WINDOWS_JOIN } from '../admin/app.generated';
import { secretsEqual } from '../auth';
import type { Env } from '../env';
import { publicOrigin } from '../mcp/config';
import { connectionDigest, serverDigest } from '../mcp/names';
import { ReverseTransport } from '../mcp/transport-reverse';
import { sha256Hex } from '../shared/hash';

const ttl = 10 * 60_000;
const hex = Type.String({pattern:'^[a-f0-9]{64}$'});
const claimResult = Type.Object({status:Type.Literal('ok'), machineId:Type.String({pattern:'^paired-[1-9][0-9]{0,3}$'}),
  relay:Type.String({maxLength:300}), registration:hex, deviceToken:hex});

function signature(env: Env, payload: string) {
  if (!env.OAUTH_STORE_KEY || !/^[a-f0-9]{64}$/i.test(env.OAUTH_STORE_KEY)) throw new HttpError(503,'pairing_unavailable');
  return createHmac('sha256',Buffer.from(env.OAUTH_STORE_KEY,'hex')).update('cua-pair-v1\n'+publicOrigin(env.PUBLIC_ORIGIN)+'\n'+payload).digest('hex');
}
function verifyTicket(env: Env, request: Request) {
  const parts = /^Bearer ([a-f0-9-]{36})\.(\d{13})\.([a-f0-9]{64})\.([a-f0-9]{64})$/.exec(request.headers.get('Authorization') ?? '');
  const client = request.headers.get('X-Cua-Client') ?? '';
  if (!parts || !/^[a-f0-9]{64}$/.test(client)) throw new HttpError(401,'invalid_pairing');
  const [,invitation,end,revision,mac] = parts;
  const expires = Number(end);
  if (Date.now() >= expires || expires > Date.now()+ttl || !secretsEqual(signature(env,[invitation,end,revision].join('.')),mac!))
    throw new HttpError(401,'invalid_pairing');
  return {invitation:invitation!,revision:revision!,client:sha256Hex(client)};
}

async function current(env: Env) {
  const config = await env.REGISTRY.getByName('main').mcpConfig();
  const server = config.servers.find(s => s.id === 'cua' && s.enabled && s.transport.kind === 'reverse-websocket' && s.credential.kind === 'managed');
  if (!config.enabled || !server) throw new HttpError(503,'pairing_unavailable');
  return server;
}
/** 管理子协议独占短连接，无 MCP 会话，也不经过工具发现、对话或工具结果存储。 */
async function control(env: Env, digest: string, params: Record<string,string>) {
  const signal = AbortSignal.timeout(5000);
  const transport = new ReverseTransport(env,digest,4096,signal);
  const id = randomUUID();
  const reply = Promise.withResolvers<Record<string,unknown>>();
  const unavailable = () => reply.reject(new HttpError(503,'pairing_unavailable'));
  transport.onmessage = msg => {
    if (!('id' in msg) || msg.id !== id || !('result' in msg)) return unavailable();
    reply.resolve(msg.result);
  };
  transport.onerror = unavailable;
  transport.onclose = unavailable;
  signal.addEventListener('abort',unavailable,{once:true});
  try {
    const send = async () => {
      await transport.start();
      if (signal.aborted) { await transport.close(); signal.throwIfAborted(); }
      await transport.send({jsonrpc:'2.0',id,method:'joule/cua/pair',params});
    };
    const [,result] = await Promise.all([send(),reply.promise]);
    if (result.status === 'full') throw new HttpError(409,'pairing_full');
    if (result.status === 'used') throw new HttpError(409,'pairing_used');
    return result;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(503,'pairing_unavailable');
  } finally {
    signal.removeEventListener('abort',unavailable);
    await transport.close();
  }
}

export async function issuePairing(env: Env) {
  const server = await current(env), revision = serverDigest(server);
  const result = await control(env,connectionDigest(server),{action:'ready'});
  if (result.status !== 'ready') throw new HttpError(503,'pairing_unavailable');
  if (!await env.REGISTRY.getByName('main').mcpServerCurrent('cua',revision)) throw new HttpError(409,'conflict');
  const expires = Date.now()+ttl;
  const payload = [randomUUID(),expires,revision].join('.');
  return adminJson({ticket:payload+'.'+signature(env,payload),expires,origin:publicOrigin(env.PUBLIC_ORIGIN)});
}

export async function devicePairing(request: Request, env: Env) {
  const url = new URL(request.url);
  if (url.search) return adminJson({error:'invalid_request'},400);
  if (request.method === 'GET' && (url.pathname === '/cua/join/mac.sh' || url.pathname === '/cua/join/windows.ps1')) {
    return new Response(url.pathname.endsWith('.sh') ? CUA_MAC_JOIN : CUA_WINDOWS_JOIN,{headers:{...API_HEADERS,'Content-Type':'text/plain; charset=utf-8'}});
  }
  if (request.method !== 'POST' || url.pathname !== '/cua/join/claim') return adminJson({error:'not_found'},404);
  try {
    const {invitation,revision,client} = verifyTicket(env,request);
    const server = await current(env);
    if (serverDigest(server) !== revision) throw new HttpError(401,'invalid_pairing');
    const result = await control(env,connectionDigest(server),{action:'claim',invitation,client});
    if (!Check(claimResult,result)) throw new HttpError(503,'pairing_unavailable');
    const relay = new URL(result.relay);
    if (relay.protocol !== 'wss:' || relay.origin !== result.relay) throw new HttpError(503,'pairing_unavailable');
    if (!await env.REGISTRY.getByName('main').mcpServerCurrent('cua',revision)) throw new HttpError(409,'conflict');
    return new Response([result.relay,result.machineId,result.registration,result.deviceToken].join('\n')+'\n',
      {headers:{...API_HEADERS,'Content-Type':'text/plain; charset=utf-8'}});
  } catch (error) {
    return error instanceof HttpError ? adminJson({error:error.code},error.status) : adminJson({error:'pairing_unavailable'},503);
  }
}
