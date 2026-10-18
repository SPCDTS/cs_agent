import { describe, expect, it, vi } from 'vitest';
import { fauxAssistantMessage, type Message } from '@earendil-works/pi-ai';
import type { PiContextAdapter } from '../../src/obs/context/pi-history.js';

vi.mock('js-tiktoken/lite', () => { throw new Error('fixture tokenizer unavailable'); });

describe('词表不可用时明确回退', () => {
  it('Pi 保持契约且在 notes 与 tokenizer 标出 pi-ai', async () => {
    const { analyzeContext } = await import('../../src/obs/context/index.js');
    const messages: Message[] = [{ role: 'user', content: '回退测试', timestamp: 1000 }, fauxAssistantMessage('回答', { timestamp: 2000 })];
    const adapter: PiContextAdapter = {
      listSessions: async () => [{ backend: 'pi', id: '1', label: 'owner', status: 'active', started: 1000, updated: 2000, turns: 1 }],
      turns: async () => [{ turn: '2', started: 1000, preview: '', requests: 1, tools: 0, status: 'ok' }], blocks: async () => [], content: async () => '',
      context: async () => ({ head: undefined, entries: [], contributions: [], messages }),
    };
    const result = await analyzeContext({ pi: adapter }, 'pi', '1');
    expect(result.estimated.tokenizer).toBe('pi-ai estimateMessageTokens');
    expect(result.estimated.total).toBeGreaterThan(0);
    expect(result.notes.join('')).toContain('o200k_base 不可用');
  });
});
