import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { codexMessage, normalizeCodexHistory, projectRecord, reconstructCodexHistory } from '../../src/obs/context/codex-history.js';
import { estimateTokens, MAX_BODY_BYTES, tokenizerName } from '../../src/obs/context/tokens.js';

const fixture = async (name: string) => Promise.all((await readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'))
  .trim().split(/\r?\n/).map(line => projectRecord(JSON.parse(line))));
const event = (type: string, extra = {}) => ({ type: 'event_msg', payload: { type, ...extra } });
const message = (text: string, role = 'user') => ({ type: 'response_item', payload: { type: 'message', role, content: [{ type: 'input_text', text }] } });
const project = async (rows: unknown[]) => Promise.all(rows.map(row => projectRecord(row)));

describe('Codex 历史重建回归', () => {
  it('普通真实匿名 rollout 按手写序列重建，保留摘要而丢弃密文', async () => {
    const history = (await reconstructCodexHistory(await fixture('codex-rollout-anonymized.jsonl')));
    expect(history.map(m => m.kind)).toEqual(['user', 'thinking', 'tool_call', 'tool_result', 'assistant']);
    expect(history.map(m => m.preview)).toEqual(['请检查测试目录。QQ 号码已替换为匿名标记。', '先读取目录结构',
      '{"name":"exec_command","input":"{\\"command\\":\\"ls test\\"}"}', 'obs\nagent', '已检查两个测试目录。']);
    expect(JSON.stringify(history)).not.toContain('匿名加密占位');
  });
  it('replacement_history 先替换基线再重放，旧问答不复活', async () => {
    const rows = await fixture('context-compaction.jsonl');
    expect((await reconstructCodexHistory(rows.slice(0, 10))).map(m => m.preview)).toEqual(['第一问', '第一答', '第二问']);
    const history = (await reconstructCodexHistory(rows));
    expect(history.map(m => m.kind)).toEqual(['user', 'user', 'tool_call', 'tool_result', 'assistant']);
    expect(history[0].category).toBe('compaction');
    expect(history.map(m => m.preview)).not.toContain('第一问');
  });
  it('第二个 resume rollout 保留旧基线；中止保留输入并补 aborted 输出', async () => {
    const history = (await reconstructCodexHistory([...(await fixture('context-compaction.jsonl')), ...(await fixture('context-resume-abort.jsonl'))]));
    expect(history.map(m => m.kind)).toEqual(['user', 'user', 'tool_call', 'tool_result', 'assistant', 'user', 'thinking', 'tool_call', 'tool_result']);
    expect(history.at(-1)).toMatchObject({ preview: 'aborted', provenance: 'reconstructed' });
    expect(JSON.stringify(history)).not.toContain('fixture-encrypted-private-body');
  });
  it('回滚撤销包含最新压缩的回合，恢复较早存活基线', async () => {
    const rows = await fixture('context-compaction.jsonl');
    rows.push(await projectRecord(event('thread_rolled_back', { num_turns: 1 })));
    expect((await reconstructCodexHistory(rows)).map(m => m.preview)).toEqual(['第一问', '第一答']);
  });
  it('多次回滚跳过无用户上下文片段，保留初始指令', async () => {
    const rows = await project([message('基础规则', 'developer'), event('task_started', { turn_id: 'a' }), message('a'), message('答a', 'assistant'),
      event('task_started', { turn_id: 'empty' }), { type: 'turn_context', payload: { turn_id: 'empty' } },
      event('task_started', { turn_id: 'b' }), message('b'), event('thread_rolled_back', { num_turns: 1 }),
      event('task_started', { turn_id: 'c' }), message('c'), event('thread_rolled_back', { num_turns: 2 })]);
    expect((await reconstructCodexHistory(rows)).map(m => m.preview)).toEqual(['基础规则']);
  });
  it('原始 system 消息不进入历史，字符串形式的 AGENTS 注入不消耗回滚回合', async () => {
    const rows = await project([message('非 API system 消息', 'system'),
      { type: 'response_item', payload: { type: 'message', role: 'user', content: '# AGENTS.md instructions\n保留规则' } },
      message('真正的用户输入'), event('thread_rolled_back', { num_turns: 1 })]);
    const history = await reconstructCodexHistory(rows);
    expect(history.map(m => m.preview)).toEqual(['# AGENTS.md instructions\n保留规则']);
    expect(history[0]).toMatchObject({ category: 'instructions', boundary: false });
  });
  it('回滚同时移除紧邻被撤销输入的上下文更新', async () => {
    const rows = await project([message('初始规则', 'developer'), message('a'), message('答a', 'assistant'),
      message('<environment_context>更新</environment_context>'), message('<permissions instructions>变化', 'developer'), message('b'),
      event('thread_rolled_back', { num_turns: 1 })]);
    expect((await reconstructCodexHistory(rows)).map(m => m.preview)).toEqual(['初始规则', 'a', '答a']);
  });
  it('迟到的中止事件不把已完成旧回合与当前片段混合', async () => {
    const rows = await project([event('task_started', { turn_id: 'a' }), message('a'), event('task_complete', { turn_id: 'a' }),
      event('task_started', { turn_id: 'b' }), message('b'), event('turn_aborted', { turn_id: 'a' }), event('thread_rolled_back', { num_turns: 1 })]);
    expect((await reconstructCodexHistory(rows)).map(m => m.preview)).toEqual(['a']);
  });
  it('新 resume checkpoint 的 suffix 回滚在替换基线上执行', async () => {
    const rows = await project([message('过时输入'), { type: 'compacted', payload: { window_number: 1, resume_metadata: {}, replacement_history: [
      { type: 'message', role: 'user', content: '基线输入' }, { type: 'message', role: 'assistant', content: '基线回答' }] } },
      event('thread_rolled_back', { num_turns: 1 })]);
    expect((await reconstructCodexHistory(rows))).toEqual([]);
  });
  it('孤儿输出删除，具名外部输出与 server tool_search 输出保留', async () => {
    const messages = await Promise.all([
      { type: 'function_call_output', call_id: 'orphan', output: '删除' },
      { type: 'function_call_output', name: 'external', output: '外部' },
      { type: 'tool_search_output', call_id: 'server', execution: 'server', tools: [] },
    ].map(m => codexMessage(m)));
    expect(normalizeCodexHistory(messages.filter(m => !!m)).map(m => m.preview)).toEqual(['外部', '[]']);
  });
  it('加密 reasoning 和多模态只保留摘要或不可用占位', async () => {
    const m = await codexMessage({ type: 'message', role: 'user', content: [{ type: 'input_text', text: '看图' }, { type: 'input_image', image_url: 'data:private-body' }] });
    const r = await codexMessage({ type: 'reasoning', encrypted_content: 'private-body' });
    expect(m?.hidden).toBe(true); expect(r?.tokens).toEqual({}); expect(r?.provenance).toBe('unavailable');
    expect(JSON.stringify([m, r])).not.toContain('private-body');
  });
  it('最终模型不支持的图像和音频在配对规范化后替换成官方文本', async () => {
    const rows = await project([message('较早输入'), { type: 'response_item', payload: { type: 'message', role: 'user', content: [
      { type: 'input_image', image_url: 'private-image' }, { type: 'input_audio', data: 'private-audio' }] } },
      { type: 'turn_context', payload: { input_modalities: ['text'] } }]);
    const result = (await reconstructCodexHistory(rows));
    expect(result.at(-1)?.preview).toBe('image content omitted because you do not support image input\naudio content omitted because you do not support audio input');
    expect(result.at(-1)?.provenance).toBe('reconstructed');
    expect(result.at(-1)?.hidden).toBe(false);
  });
  it('运行时中止提示不算新的用户回合，工具 JSON 的凭据字段脱敏', async () => {
    const rows = await project([message('真实输入'), message('<turn_aborted>运行时提示</turn_aborted>'), event('thread_rolled_back', { num_turns: 1 })]);
    expect((await reconstructCodexHistory(rows))).toEqual([]);
    const call = await codexMessage({ type: 'function_call', name: 'lookup', call_id: 'c', arguments: '{"nested":{"password":"fixture-password"}}' });
    expect(call?.preview).toContain('已隐藏'); expect(JSON.stringify(call)).not.toContain('fixture-password');
  });
  it('旧式压缩保留最近 20000 近似 token 用户输入，并按官方方式截断中间', async () => {
    const rows = await project([message('应被丢弃'), message('x '.repeat(50_000)), message('tail'),
      { type: 'compacted', payload: { message: '旧式摘要' } }]);
    const history = await reconstructCodexHistory(rows);
    expect(history).toHaveLength(3);
    expect(history.map(m => m.preview)).not.toContain('应被丢弃');
    expect(history[0].provenance).toBe('reconstructed');
    expect(history[1].preview).toBe('tail'); expect(history[2].preview).toBe('旧式摘要');
    expect(history[2].category).toBe('compaction');
  });
  it('工具声明和 web search 使用可见负载，未知加密记录标 unavailable', async () => {
    const tools = await codexMessage({ type: 'additional_tools', tools: [{ name: 'lookup', description: '工具定义' }] });
    const web = await codexMessage({ type: 'web_search_call', action: { type: 'search', query: '匿名查询' } });
    const unknown = await codexMessage({ type: 'future_record', encrypted_content: 'private-body' });
    expect(tools?.preview).toContain('工具定义'); expect(web?.preview).toContain('匿名查询');
    expect(unknown).toMatchObject({ category: 'other', provenance: 'unavailable', tokens: {} });
    expect(JSON.stringify(unknown)).not.toContain('private-body');
  });
});

describe('本地 o200k token 估算', () => {
  it('中英文和特殊 token 字面量确定性，包含角色开销', async () => {
    expect(await tokenizerName()).toBe('o200k_base');
    const body = '你好，hello <|endoftext|>';
    const first = await estimateTokens(body, 'user');
    expect(await estimateTokens(body, 'user')).toEqual(first);
    expect(first.tokens).toBeGreaterThan(4); expect(first.truncated).toBe(false);
  });
  it('单条 2 MiB 上限按 UTF-8 字节截断，重复文本也有界', async () => {
    const body = 'x '.repeat(MAX_BODY_BYTES / 2);
    expect(await estimateTokens(body + ' extra', 'user')).toEqual({ ...(await estimateTokens(body, 'user')), truncated: true });
  });
});
