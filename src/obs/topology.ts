/**
 * Agent 拓扑（/agents 页顶部，docs/DASHBOARD.md）：每个会话的主 agent 与它派出的子 agent，
 * 各自的状态与最近一个动作。会话与子 agent 列表由宿主与两个后端给出，最近动作取自会话索引（只读）。
 */
import type { SessionAdapters } from './sessions/http.js';
import { redactSessionValue } from './sessions/content.js';
import type { Activity, Block, ThreadTopology, TopologyRow } from './sessions/types.js';

const clip = (text: string, n = 160) => { const one = text.replace(/\s+/g, ' ').trim(); return one.length > n ? one.slice(0, n - 1) + '…' : one; };

/** 一个块的一句话描述；没有可描述内容的块（事件、系统变更）返回 undefined。 */
export function describeBlock(b: Block): string | undefined {
  const text = b.text ?? b.preview ?? '';
  const name = typeof b.meta?.name === 'string' ? b.meta.name : '工具';
  switch (b.kind) {
    case 'tool_call': return `调用 ${name}${text ? '：' + clip(text, 120) : ''}`;
    case 'tool_result': return `工具返回${text ? '：' + clip(text, 120) : ''}`;
    case 'assistant': return text ? `回复：${clip(text)}` : undefined;
    case 'thinking': return '思考中';
    case 'user': return text ? `收到：${clip(text)}` : undefined;
    case 'compaction': return '压缩上下文';
    default: return undefined;
  }
}

/** 会话最近一个可描述的动作（最后一个回合里从后往前找）；会话未索引或读取失败时 undefined。 */
async function lastActivity(adapters: SessionAdapters, backend: 'pi' | 'codex' | undefined, session: string | undefined): Promise<Activity | undefined> {
  const adapter = backend && adapters[backend];
  if (!adapter || !session) return undefined;
  try {
    const turn = (await adapter.turns(session)).reduce<{ turn: string; started: number } | undefined>((last, t) => !last || t.started >= last.started ? t : last, undefined);
    if (!turn) return undefined;
    const blocks = await adapter.blocks(session, turn.turn);
    for (let i = blocks.length - 1; i >= 0; i--) {
      const text = describeBlock(blocks[i]!);
      if (text) return { text, ...(blocks[i]!.ts !== undefined ? { ts: blocks[i]!.ts } : {}) };
    }
  } catch { /* 子会话可能还没被索引 */ }
  return undefined;
}

/** 补上工作中或派出过子 agent 的会话的最近动作，并按会话正文规则脱敏；会话按工作中优先、再按标签排序。 */
export async function topologyRows(rows: ThreadTopology[], adapters: SessionAdapters): Promise<TopologyRow[]> {
  const out = await Promise.all(rows.map(async row => {
    // 空闲且没有子 agent 的会话在页面上只列名称，不读正文
    if (!row.busy && !row.children.length) return { ...row, children: [] };
    const [activity, children] = await Promise.all([
      lastActivity(adapters, row.backend, row.session),
      Promise.all(row.children.map(async child => {
        const activity = await lastActivity(adapters, row.backend, child.session);
        return activity ? { ...child, activity } : child;
      })),
    ]);
    return { ...row, ...(activity ? { activity } : {}), children };
  }));
  const working = (r: TopologyRow) => r.busy || r.children.some(c => c.state === 'running');
  return (redactSessionValue(out) as TopologyRow[]).sort((a, b) => Number(working(b)) - Number(working(a)) || Number(b.children.length > 0) - Number(a.children.length > 0)
    || Number(b.thread === 'owner') - Number(a.thread === 'owner') || a.thread.localeCompare(b.thread));
}
