import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ObsStore } from '../../src/obs/store.js';
import { Trace } from '../../src/shared/trace.js';
import { Metrics } from '../../src/obs/metrics.js';
import { registerSecrets } from '../../src/shared/redact.js';
import { startAlerts } from '../../src/obs/alerts.js';
import type { ContextUsage } from '../../src/shared/format.js';

const clean: (()=>void)[]=[];
afterEach(()=>{vi.useRealTimers(); for(const fn of clean.splice(0).reverse())fn();});
function rig(){const dir=mkdtempSync(path.join(os.tmpdir(),'cs-obs-'));const store=new ObsStore(dir);clean.push(()=>rmSync(dir,{recursive:true,force:true}),()=>store.close());return {dir,store,trace:new Trace(store)};}
describe('观测存储',()=>{
  it('WAL 写入、跨连接读取、scope 继承、筛选、分页、保留清理',()=>{
    const {dir,store,trace}=rig();
    expect(store.db.prepare('PRAGMA journal_mode').get()).toMatchObject({journal_mode:'wal'});
    for(let i=0;i<53;i++){
      trace.event('t'+i,'received',{scope:'group:7',detail:{sender:'测试'}});
      trace.event('t'+i,'routed',{detail:{route:'agent'}});
      trace.event('t'+i,'backend:pi',{durationMs:10,detail:{backend:'pi'}});
      trace.event('t'+i,'reply_sent',{detail:{terminal:true}});
    }
    const reader=new ObsStore(dir);try{expect(reader.events('t0')).toHaveLength(4);}finally{reader.close();}
    expect(store.events('t0').every(e=>e.scope==='group:7')).toBe(true);
    expect(store.tickets({scope:'group:7',status:'sent',route:'agent',backend:'pi'})).toHaveLength(50);
    expect(store.tickets({page:1})).toHaveLength(3);
    expect(store.tickets({scope:"' OR 1=1 --"})).toEqual([]);
    expect(store.throughput(0)).toEqual({total:53,failed:0,error_rate:0});
    store.metric(1,'old',{},1);
    store.append({ticket:'old',scope:'',ts:1,stage:'failed',status:'failed',duration_ms:null});
    expect(store.purge(30)).toEqual({events:1,metrics:1});
    expect(store.events('t0')).toHaveLength(4);
  });
  it('秘密先脱敏后截断，数据库和 WAL 不保存假 token',async()=>{
    const {dir,store,trace}=rig();const secret='fake-obs-credential-123456789';registerSecrets([secret]);
    trace.event('redact','received',{detail:{token:secret,tokens:'opaque-credential-value',keys:['opaque-key-value'],nested:{api_key:secret},prompt:'猫'.repeat(490)+secret,reply:secret+'字'.repeat(700),error:new Error('Bearer '+secret)}});
    const raw=store.events('redact')[0]!.detail_json;
    expect(raw).not.toContain(secret);expect(raw).not.toContain('opaque-');expect(JSON.parse(raw).prompt.length).toBeLessThanOrEqual(500);expect(JSON.parse(raw).reply.length).toBeLessThanOrEqual(500);
    expect(readFileSync(path.join(dir,'observability.sqlite-wal')).includes(Buffer.from(secret))).toBe(false);
    expect(readFileSync(path.join(dir,'observability.sqlite')).includes(Buffer.from(secret))).toBe(false);
    await expect(trace.span('redact','tool:test',async()=>{throw new Error(secret);})).rejects.toThrow(secret);
    expect(store.events('redact').at(-1)).toMatchObject({status:'failed'});
    expect(store.events('redact').at(-1)!.detail_json).not.toContain(secret);
    store.close();expect(()=>trace.event('x','failed')).not.toThrow();expect(trace.dropped).toBe(1);
  });
  it('每分钟指标包含其他进程连接，p50/p95、成功率和用量费用准确且不重复',async()=>{
    const {dir,store,trace}=rig();
    const metrics=new Metrics(store,{retentionDays:30,inputPrice:2,outputPrice:4,gauges:async()=>[{name:'queue_depth',value:2}]});
    for(const ms of [10,20,100])trace.event('t','tool:test',{durationMs:ms,status:ms===100?'failed':'ok'});
    const writer=new ObsStore(dir);writer.append({ticket:'t',scope:'',ts:Date.now(),stage:'image:collect',status:'ok',duration_ms:80,detail:{prompt_id:'pid'}});writer.close();
    trace.event('t','model_turn',{detail:{provider:'deepseek',input_tokens:100,output_tokens:20,cache_read_tokens:10}});
    await metrics.flush();
    const rows=store.db.prepare('SELECT * FROM metrics').all();
    const metric=(name:string)=>rows.find(r=>r.name===name && String(r.labels_json).includes('tool:test'))?.value;
    expect(metric('duration_p50_ms')).toBe(20);expect(metric('duration_p95_ms')).toBe(100);expect(metric('success_rate')).toBeCloseTo(2/3);
    expect(rows.find(r=>r.name==='deepseek_estimated_cost')?.value).toBeCloseTo(.0003);
    expect(rows.some(r=>String(r.labels_json).includes('image:collect'))).toBe(true);
    await metrics.flush();expect(store.db.prepare("SELECT COUNT(*) n FROM metrics WHERE name='calls'").get()).toMatchObject({n:2});
    const reopened=new Metrics(store,{retentionDays:30});await reopened.flush();
    expect(store.db.prepare("SELECT COUNT(*) n FROM metrics WHERE name='calls'").get()).toMatchObject({n:2});
  });
  it('magpie 的 deepseek/ 模型沿用 DeepSeek 计价，其他模型不计入且不重复', async () => {
    const {store,trace}=rig();
    const metrics=new Metrics(store,{retentionDays:30,inputPrice:2,outputPrice:4});
    const usage={input_tokens:100,output_tokens:20,cache_read_tokens:10,cache_write_tokens:5};
    for (const [provider,model] of [
      ['deepseek','deepseek-flash'], ['magpie','deepseek/deepseek-flash'],
      ['magpie','codex/gpt-6.1-sol'], ['magpie','deepseek-flash'], ['magpie','deepseekish/model'],
      ['other','deepseek/deepseek-flash'], ['magpie',undefined],
    ]) trace.event('billing','model_turn',{status:'ok',detail:{provider,model,...usage}});
    trace.event('billing','model_turn',{status:'started',detail:{provider:'magpie',model:'deepseek/deepseek-flash',...usage}});
    trace.event('billing','tool:web',{status:'ok',detail:{provider:'magpie',model:'deepseek/deepseek-flash',...usage}});
    await metrics.flush();
    const total=(name:string)=>Number(store.db.prepare('SELECT SUM(value) value FROM metrics WHERE name=?').get(name)?.value);
    expect(total('deepseek_input_tokens')).toBe(230);
    expect(total('deepseek_output_tokens')).toBe(40);
    expect(total('deepseek_estimated_cost')).toBeCloseTo(.00062);
    await metrics.flush();
    expect(total('deepseek_input_tokens')).toBe(230);
    expect(total('deepseek_estimated_cost')).toBeCloseTo(.00062);
  });
  it('告警默认关闭；连续失败、鉴权失败与 WS 离线共用限频',async()=>{
    vi.useFakeTimers();const {trace}=rig();let online=false;const send=vi.fn(async()=>({message_id:'fake'}));
    const bridge={status:()=>({ws_connected:online,disconnect_count:1,self_id:null,last_event_at:null}),send};
    const disabled=startAlerts({enabled:false,owner:'1',bridge,trace});
    trace.event('a','backend:codex',{status:'failed',detail:{failure:{kind:'auth',provider:'test',status:401}}});expect(send).not.toHaveBeenCalled();disabled.stop();
    const alerts=startAlerts({enabled:true,owner:'1',bridge,trace});clean.push(()=>alerts.stop());
    for(const t of ['a','b','c'])trace.event(t,'failed',{detail:{terminal:true}});
    expect(send).toHaveBeenCalledTimes(1);expect(send).toHaveBeenLastCalledWith('private','1',expect.stringContaining('连续三条'));
    trace.event('auth','backend:codex',{status:'failed',detail:{failure:{kind:'auth',provider:'test',status:401}}});expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(31*60_000);expect(send).toHaveBeenCalledTimes(2);
    online=true;await vi.advanceTimersByTimeAsync(31*60_000);expect(send).toHaveBeenCalledTimes(2);
    trace.event('auth2','backend:pi',{status:'failed',detail:{failure:{kind:'auth',provider:'test',status:401}}});expect(send).toHaveBeenCalledTimes(3);
  });
});

describe('上下文历史查询', () => {
  function record(store: ObsStore, ts: number, patch: Partial<ContextUsage> = {}, ticket = `turn-${ts}`) {
    const detail: ContextUsage = { backend: 'codex', key: 'owner', usedTokens: 10_000, cachedTokens: 0,
      windowTokens: 100_000, turns: 2, updatedAt: ts, source: 'turn', ...patch };
    store.append({ ticket, ts, scope: '', stage: 'context_usage', status: 'ok', duration_ms: null, detail });
    return { ts, ticket, detail };
  }
  function system(store: ObsStore, ts: number, stage: string, detail: unknown = {}, ticket = '@settings') {
    store.append({ ticket, ts, stage, detail, scope: '', status: 'ok', duration_ms: null });
  }

  it('contextSeries 按 backend/key 分组，线程按最近活动倒序，回合按 ts/id 升序', () => {
    const { store } = rig();
    record(store, 30);
    record(store, 10);
    record(store, 25, { backend: 'pi' });
    record(store, 40, { key: 'group:7' });
    record(store, 30, { cachedTokens: 9000 }, 'same-ts-later');
    record(store, 20, { backend: 'pi', key: 'group:7' });
    const series = store.contextSeries();
    expect(series.map(({ backend, key }) => [backend, key])).toEqual([
      ['codex', 'group:7'], ['codex', 'owner'], ['pi', 'owner'], ['pi', 'group:7'],
    ]);
    expect(series[1].turns.map(turn => [turn.ts, turn.ticket])).toEqual([[10, 'turn-10'], [30, 'turn-30'], [30, 'same-ts-later']]);
  });
  it('contextSeries 统计 miss，不计 partial/compact/reset，window 取最后一条的有效窗口', () => {
    const { store } = rig();
    record(store, 0);
    record(store, 1, { cachedTokens: 4999 });
    record(store, 2, { cachedTokens: 5000 });
    record(store, 3, { source: 'compact' });
    record(store, 4);
    record(store, 5, { turns: 1 });
    record(store, 6, { cachedTokens: 9000, effectiveWindowTokens: 80_000 });
    const [series] = store.contextSeries();
    expect(series.turns.map(turn => turn.mark)).toEqual(['first', 'miss', 'partial', 'compact', 'compact', 'reset', undefined]);
    expect(series).toMatchObject({ misses: 1, window: 80_000 });
  });
  it('contextSeries 每线程只保留最近 limit 条，再升序分析', () => {
    const { store } = rig();
    for (let ts = 0; ts < 8; ts++) record(store, ts, { backend: ts % 2 ? 'pi' : 'codex' });
    const series = store.contextSeries({ limit: 2 });
    expect(series.map(group => group.turns.map(turn => turn.ts))).toEqual([[5, 7], [4, 6]]);
    expect(series.every(group => group.turns[0].mark === 'first' && group.misses === 1)).toBe(true);
  });
  it('contextSeries limit 默认 40，范围 1–200，取整且非有限值回退默认', () => {
    const { store } = rig();
    for (let ts = 0; ts < 205; ts++) record(store, ts, {}, '@context');
    for (const limit of [undefined, NaN, Infinity]) {
      const [series] = store.contextSeries({ limit });
      expect(series.turns).toHaveLength(40);
      expect(series.turns[0].ts).toBe(165);
    }
    expect(store.contextSeries({ limit: 999 })[0].turns).toHaveLength(200);
    expect(store.contextSeries({ limit: 0 })[0].turns.map(turn => turn.ts)).toEqual([204]);
    expect(store.contextSeries({ limit: -5 })[0].turns).toHaveLength(1);
    expect(store.contextSeries({ limit: 2.9 })[0].turns.map(turn => turn.ts)).toEqual([203, 204]);
  });
  it('contextSeries since 包含边界，区间外历史不成为比较基准', () => {
    const { store } = rig();
    record(store, 0);
    record(store, 10);
    record(store, 20);
    expect(store.contextSeries({ since: 10 })[0].turns.map(turn => [turn.ts, turn.mark])).toEqual([[10, 'first'], [20, 'miss']]);
    expect(store.contextSeries({ since: 21 })).toEqual([]);
    expect(store.contextSeries({ since: NaN })[0].turns).toHaveLength(3);
  });
  it('contextSeries 支持 backend/key 单独与组合过滤，过滤先于全局取数且参数绑定', () => {
    const { store } = rig();
    record(store, 1);
    record(store, 2, { backend: 'pi' });
    record(store, 3, { backend: 'pi', key: 'group:7' });
    for (let ts = 4; ts < 20; ts++) record(store, ts, { key: 'group:7' });
    expect(store.contextSeries({ backend: 'pi' }).map(group => group.key)).toEqual(['group:7', 'owner']);
    expect(store.contextSeries({ key: 'owner' }).map(group => group.backend)).toEqual(['pi', 'codex']);
    expect(store.contextSeries({ backend: 'codex', key: 'owner', limit: 1 })[0].turns[0].ts).toBe(1);
    expect(store.contextSeries({ backend: "' OR 1=1 --" })).toEqual([]);
    expect(store.contextSeries({ key: "' OR 1=1 --" })).toEqual([]);
    expect(store.contextSeries({ key: '' })).toEqual([]);
  });
  it('contextSeries 跳过 estimate、非 context_usage 事件和无法解析的 detail', () => {
    const { store } = rig();
    record(store, 1);
    record(store, 2, { source: 'compact' });
    record(store, 3);
    for (let ts = 4; ts < 12; ts++) record(store, ts, { source: 'estimate' });
    system(store, 12, 'model_turn', { backend: 'codex', key: 'owner', source: 'turn' });
    system(store, 13, 'context_usage', null);
    system(store, 14, 'context_usage', { backend: 'pi', key: 'bad', source: 'turn', usedTokens: 'bad', windowTokens: 100_000 });
    const [series] = store.contextSeries({ limit: 3 });
    expect(store.contextSeries()).toHaveLength(1);
    expect(series.turns.map(turn => turn.ts)).toEqual([1, 2, 3]);
    expect(series.turns.map(turn => turn.mark)).toEqual(['first', 'compact', 'compact']);
  });
  it('contextSeries 只用 @settings 的相关事件解释原因并保持时间顺序', () => {
    const { store } = rig();
    record(store, 10);
    record(store, 100);
    system(store, 30, 'settings_changed', { changed: ['codexModel'], before: { codexModel: 'old' }, after: { codexModel: 'new' } });
    system(store, 20, 'prompt_changed', { target: 'codex' });
    system(store, 10, 'prompt_changed');
    system(store, 40, 'settings_changed', { changed: ['alertOwner'] });
    system(store, 50, 'prompt_changed', {}, '@other');
    system(store, 101, 'prompt_changed');
    expect(store.contextSeries()[0].turns[1].reasons).toEqual(['提示词变更', '切换模型']);
    expect(store.contextSeries({ since: 100 })[0].turns[0].reasons).toEqual([]);
  });
  it('contextSeries 系统查询最多取最近 500 条相关 @settings 事件', () => {
    const { store } = rig();
    record(store, 0);
    record(store, 1000);
    system(store, 1, 'settings_changed', { changed: ['codexModel'] });
    for (let ts = 2; ts <= 501; ts++) system(store, ts, 'prompt_changed');
    system(store, 600, 'unrelated');
    expect(store.contextSeries()[0].turns[1].reasons).toEqual(['提示词变更']);
  });
  it('contextSeries 重置事件不替代 turns===1 判据，也不影响其他线程', () => {
    const { store } = rig();
    record(store, 0);
    record(store, 0, { backend: 'pi' });
    system(store, 1, 'thread_reset', { backend: 'codex', thread_key: 'owner' }, '@codex');
    system(store, 1, 'thread_reset', { backend: 'pi', conversation_key: 'group:7' }, '@pi');
    record(store, 2, { turns: 1 });
    record(store, 2, { backend: 'pi' });
    const series = store.contextSeries();
    expect(series.find(group => group.backend === 'codex')!.turns[1].mark).toBe('reset');
    expect(series.find(group => group.backend === 'pi')!.turns[1].mark).toBe('miss');
  });
  it('contextSeries 先取最近 M=线程数×limit 条，冷线程可能在有界快照之外', () => {
    const { store } = rig();
    record(store, 0, { key: 'cold' });
    for (let ts = 1; ts <= 5; ts++) record(store, ts);
    const series = store.contextSeries({ limit: 2 });
    expect(series).toHaveLength(1);
    expect(series[0].turns.map(turn => turn.ts)).toEqual([4, 5]);
  });
  it('contextSeries 全局上下文快照最多 2000 条', () => {
    const { store } = rig();
    for (let ts = 0; ts < 2100; ts++) record(store, ts, { key: `group:${ts % 11}` }, '@context');
    const turns = store.contextSeries({ limit: 200 }).flatMap(group => group.turns);
    expect(turns).toHaveLength(2000);
    expect(Math.min(...turns.map(turn => turn.ts))).toBe(100);
    expect(Math.max(...turns.map(turn => turn.ts))).toBe(2099);
  });
  it('previousContextTurn 严格早于 beforeTs，忽略压缩/估算及其他线程，按 ts 而非插入顺序选取', () => {
    const { store } = rig();
    const expected = record(store, 20);
    record(store, 10);
    record(store, 30);
    record(store, 25, { source: 'compact' });
    record(store, 26, { source: 'estimate' });
    record(store, 27, { backend: 'pi' });
    record(store, 28, { key: 'group:7' });
    expect(store.previousContextTurn('codex', 'owner', 30)).toEqual(expected);
    expect(store.previousContextTurn('codex', 'owner', 20)?.ts).toBe(10);
    expect(store.previousContextTurn('codex', 'owner', 10)).toBeUndefined();
    expect(store.previousContextTurn('codex', "' OR 1=1 --", 100)).toBeUndefined();
    expect(store.previousContextTurn('codex', 'owner', NaN)).toBeUndefined();
  });
  it('previousContextTurn 同时间戳取后插入记录并跳过无效 detail', () => {
    const { store } = rig();
    record(store, 1);
    const expected = record(store, 1, { cachedTokens: 7000 }, 'later-id');
    system(store, 2, 'context_usage', { backend: 'codex', key: 'owner', source: 'turn', usedTokens: 'bad' });
    expect(store.previousContextTurn('codex', 'owner', 3)).toEqual(expected);
  });
  it('上下文查询不修改存储，空库与 degraded 返回空结果', () => {
    const { store } = rig();
    expect(store.contextSeries()).toEqual([]);
    expect(store.previousContextTurn('codex', 'owner', 1)).toBeUndefined();
    record(store, 1);
    const before = store.db.prepare('SELECT * FROM events').all();
    store.contextSeries(); store.previousContextTurn('codex', 'owner', 2);
    expect(store.db.prepare('SELECT * FROM events').all()).toEqual(before);
    store.degrade();
    expect(store.contextSeries()).toEqual([]);
    expect(store.previousContextTurn('codex', 'owner', 2)).toBeUndefined();
  });
});
