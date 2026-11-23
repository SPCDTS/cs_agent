import { env, evictDurableObject, reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import { allowed, reserveAgent, sendAgent, verifyMessage } from '../src/communication/service';
import { EdgeStore } from '../src/communication/edges';

const from = 'owner', to = 'group:200000001', actor = 'qq:10000001';
afterEach(reset);
it('retains a baseline deny after eviction and rechecks reservations, sends and receipts', async () => {
  await runInDurableObject(env.THREAD.getByName(from), async (_, state) => {
    const registry = env.REGISTRY.getByName('main');
    const host = { env, storage: state.storage, agentSessionId: from, generation: 0, readFile: async () => { throw Error(); } };
    const input = {to, text:'pending'}, ticket = await reserveAgent(host, input, 'ticket', Date.now());
    await registry.edgeSet(from, to, 'deny', actor);
    await evictDurableObject(registry);
    expect(await registry.edgeList()).toContainEqual(expect.objectContaining({from,to,baseline:true,override:'deny',effective:false,actor}));
    await expect(reserveAgent(host, input, 'new', Date.now())).rejects.toThrow('agent_session_denied');
    await expect(sendAgent(host, input, 'ticket', undefined, ticket)).rejects.toThrow('agent_session_denied');
    await expect(verifyMessage(env, to, {...input, from, files:[], id:'agent:'+'a'.repeat(64)})).rejects.toThrow('agent_session_denied');
    expect(await allowed(env,to,from)).toBe(true);
  });
});
it('needs two independent grants and rejects invalid writes or configuration even with an allow', async () => {
  const peer = 'private:42', registry = env.REGISTRY.getByName('main');
  await registry.edgeSet(from,peer,'allow',actor);
  expect(await allowed(env,from,peer)).toBe(true);
  expect(await allowed(env,peer,from)).toBe(false);
  await registry.edgeSet(peer,from,'allow',actor);
  expect(await allowed(env,peer,from)).toBe(true);
  for (const bad of [from,'*','sub:owner:'+'a'.repeat(36)]) await expect(async()=>await registry.edgeSet(from,bad,'allow',actor)).rejects.toThrow();
  await runInDurableObject(registry, (_, state) => {
    const broken = new EdgeStore(state.storage,'not json');
    expect(()=>broken.allowed(from,peer)).toThrow('agent_invalid_config');
    expect(()=>broken.set(from,peer,'deny',actor)).toThrow('agent_invalid_config');
    expect(state.storage.sql.exec('SELECT * FROM agent_edge_audit').toArray()).toHaveLength(2);
  });
});
