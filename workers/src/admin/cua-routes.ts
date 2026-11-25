import { issuePairing } from '../cua/pairing';
import { Check } from 'typebox/value';
import { CuaDeviceId, CuaGrantInput, CuaNameInput, CuaScope, CuaSetupInput, cuaCards, deviceAlias, type CuaCard } from '../cua/contracts';
import type { Env } from '../env';
import { McpConnection } from '../mcp/connection';
import { setupFailure } from '../mcp/manage';
import { MCP_CONFIG, publicOrigin } from '../mcp/config';
import { connectionDigest, serverDigest } from '../mcp/names';
import { adminJson, HttpError, readAdminBody } from './http';
import type { AdminRoute } from './routes';

async function directory(env: Env) {
  const registry = env.REGISTRY.getByName('main');
  const config = await registry.mcpConfig();
  const server = config.servers.find(row => row.id === 'cua' && row.transport.kind === 'reverse-websocket');
  const view = {configured:!!server, enabled:!!(config.enabled && server?.enabled), online:false, available:false,
    revision:server?.access.revision, devices:[] as CuaCard[], error:undefined as 'directory_unavailable' | undefined};
  if (!server) return view;
  const bridge = env.BRIDGE.getByName('mcp-reverse:' + connectionDigest(server));
  const signal = AbortSignal.timeout(MCP_CONFIG.limits.callMs);
  let connection: McpConnection | undefined;
  try {
    view.online = await bridge.reverseOnline();
    if (!view.enabled || !view.online || !server.tools.allow.includes('list_spaces')) return view;
    connection = await McpConnection.open(server,env,config.limits,signal,() => {});
    const result = await connection.callTool('list_spaces',{}, {scope:'owner'},signal);
    const devices = cuaCards(result);
    if (!await registry.mcpServerCurrent('cua',serverDigest(server))) throw new HttpError(409,'conflict');
    return {...view, available:true, devices};
  } catch (error) {
    if (error instanceof HttpError) throw error;
    return {...view, error:'directory_unavailable' as const};
  } finally {
    await connection?.close();
  }
}

export const CUA_ROUTES: AdminRoute[] = [
  {method:'POST',path:'/admin/cua/pair',handle:({env}) => issuePairing(env)},
  {method:'PUT',path:'/admin/cua/setup',handle:async ({env,request}) => {
    const {token} = await readAdminBody(request,CuaSetupInput,{maxBytes:1024});
    try {
      const result = await env.REGISTRY.getByName('main').cuaSetup(token);
      if (result.created) await env.THREAD.getByName('owner').recordMcpChange({action:'credentials',server:'cua'});
      return adminJson({saved:true});
    } catch (error) {
      if (setupFailure(error) === 'conflict') throw new HttpError(409,'conflict');
      throw error;
    }
  }},
  {method:'GET',path:'/admin/cua/grants',handle:async ({env}) => adminJson(await env.REGISTRY.getByName('main').cuaGrantsList())},
  {method:'GET',path:'/admin/cua/devices',handle:async ({env}) => {
    const registry = env.REGISTRY.getByName('main');
    const [before,threads,setup] = await Promise.all([registry.cuaGrantsList(),env.BRIDGE.getByName('napcat').threadList(),registry.cuaSetupState()]);
    const view = await directory(env);
    const names: Record<string,string> = view.revision ? await registry.cuaNames(view.devices.map(row => row.id),view.revision) : {};
    const after = await registry.cuaGrantsList();
    if (before.revision !== after.revision) throw new HttpError(409,'conflict');
    const scopesByDevice = new Map<string,string[]>();
    for (const grant of after.grants) for (const id of grant.spaces) {
      const scopes = scopesByDevice.get(id);
      if (scopes) scopes.push(grant.scope);
      else scopesByDevice.set(id,[grant.scope]);
    }
    const bridgeUrl = new URL('/mcp/reverse/cua',publicOrigin(env.PUBLIC_ORIGIN));
    bridgeUrl.protocol = 'wss:';
    return adminJson({setup,bridgeUrl:bridgeUrl.href,configured:view.configured,enabled:view.enabled,online:view.online,available:view.available,error:view.error,...after,
      devices:view.devices.map(row => {
        const alias = deviceAlias(names,row.id);
        return {...row,defaultName:row.name,alias,name:alias ?? row.name,scopes:scopesByDevice.get(row.id) ?? []};
      }),
      threads:threads.filter(row => Check(CuaScope,row.key)).map(({key,name}) => ({key,name}))});
  }},
  {method:'PUT',path:'/admin/cua/name',handle:async ({env,request}) => {
    const input = await readAdminBody(request,CuaNameInput,{maxBytes:2048});
    const view = await directory(env);
    if (!view.available || !view.revision) throw new HttpError(503,'cua_directory_unavailable');
    if (!view.devices.some(device => device.id === input.space)) throw new HttpError(400,'unknown_space');
    const result = await env.REGISTRY.getByName('main').cuaRename(input,view.revision);
    if (result.status !== 'ok') throw new HttpError(result.status === 'conflict' ? 409 : 400,result.status);
    return adminJson({name:result.name});
  }},
  {method:'PUT',path:'/admin/cua/grants',handle:async ({env,request}) => {
    const input = await readAdminBody(request,CuaGrantInput,{maxBytes:32768});
    const registry = env.REGISTRY.getByName('main');
    const current = await registry.cuaGrantsList();
    if (current.revision !== input.expectedRevision) throw new HttpError(409,'conflict');
    const prior = current.grants.find(grant => grant.scope === input.scope)?.spaces ?? [];
    const additions = input.spaces.filter(id => !prior.includes(id));
    let revision: string | undefined;
    if (additions.length) {
      const view = await directory(env);
      if (!view.available) throw new HttpError(503,'cua_directory_unavailable');
      if (additions.some(id => !view.devices.some(row => row.id === id && Check(CuaDeviceId,row.id)))) {
        throw new HttpError(400,'unknown_space');
      }
      revision = view.revision;
    }
    const result = await registry.cuaGrantsPut(input,revision);
    if (result.status !== 'ok') throw new HttpError(result.status === 'conflict' ? 409 : 400,result.status);
    return adminJson({revision:result.revision,grants:result.grants});
  }},
];
