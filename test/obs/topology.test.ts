import { describe, expect, it } from 'vitest';
import { describeBlock, topologyRows } from '../../src/obs/topology.js';
import type { Block, SessionAdapter } from '../../src/obs/sessions/types.js';

describe('拓扑的最近动作', () => {
  it('工具调用带名称与参数摘要，回复与输入折成一行并截断，事件与系统变更不算动作', () => {
    expect(describeBlock({ kind: 'tool_call', text: '{"command":\n"ls -la"}', meta: { name: 'bash' } })).toBe('调用 bash：{"command": "ls -la"}');
    expect(describeBlock({ kind: 'assistant', text: '好'.repeat(300) })).toMatch(/^回复：好{159}…$/);
    expect(describeBlock({ kind: 'thinking' })).toBe('思考中');
    expect(describeBlock({ kind: 'event', text: '模型请求' })).toBeUndefined();
    expect(describeBlock({ kind: 'system_change', text: '系统提示已更新' })).toBeUndefined();
  });

  it('取最后一个回合里最后一个可描述的块；会话未索引时不带最近动作；工作中的会话排在前面', async () => {
    const blocks: Record<string, Block[]> = {
      main: [{ kind: 'user', ts: 1, text: '问' }, { kind: 'tool_call', ts: 2, text: '{}', meta: { name: 'web' } }, { kind: 'event', ts: 3, text: '模型请求' }],
    };
    const adapter = {
      turns: async (id: string) => {
        if (!(id in blocks)) throw new Error('会话不存在');
        return [{ turn: 'old', started: 0 }, { turn: 'new', started: 5 }];
      },
      blocks: async (id: string, turn: string) => turn === 'new' ? blocks[id]! : [{ kind: 'assistant' as const, text: '旧回合' }],
    } as unknown as SessionAdapter;
    const rows = await topologyRows([
      { thread: 'group:2', backend: 'pi', busy: false, children: [] },
      { thread: 'group:1', backend: 'pi', busy: false, session: 'main', children: [{ session: 'missing', name: 'w', state: 'running' }] },
    ], { pi: adapter });
    expect(rows.map(r => r.thread)).toEqual(['group:1', 'group:2']);
    expect(rows[0]!.activity).toEqual({ text: '调用 web：{}', ts: 2 });
    expect(rows[0]!.children[0]!.activity).toBeUndefined();
  });
});
