import { describe, expect, it } from 'vitest';
import { contentSlice, utf8Slice, validRange } from '../../src/obs/sessions/content.js';
import { registerTemporarySecrets } from '../../src/shared/redact.js';

const text = '甲a乙🙂é丙𠮷丁';
const bytes = Buffer.byteLength(text);
const indexed = { session: 'fixture', offset: 100, length: bytes, bytes };

describe('UTF-8 正文分块', () => {
  it.each([1, 2, 3])('按 %i 字节固定步长读取，不丢失或重复任何字符', step => {
    let raw = '', content = '';
    for (let offset = 0; offset < bytes; offset += step) {
      raw += utf8Slice(text, offset, step);
      content += contentSlice(text, { ...indexed, offset: indexed.offset + offset, length: step }, indexed);
    }
    expect(raw).toBe(text);
    expect(content).toBe(text);
  });

  it('跨界字符完整归前一块，只含续字节的后续块为空', () => {
    expect(utf8Slice('🙂甲', 0, 1)).toBe('🙂');
    expect(utf8Slice('🙂甲', 1, 1)).toBe('');
    expect(utf8Slice('🙂甲', 2, 2)).toBe('');
    expect(utf8Slice('🙂甲', 3, 2)).toBe('甲');
  });

  it('末块最多允许多请求 3 字节，输出始终止于正文末尾', () => {
    expect(validRange({ ...indexed, length: bytes + 3 }, indexed)).toBe(true);
    expect(contentSlice(text, { ...indexed, length: bytes + 3 }, indexed)).toBe(text);
    for (const ref of [
      { ...indexed, length: bytes + 4 }, { ...indexed, offset: indexed.offset - 1 },
      { ...indexed, offset: indexed.offset + bytes, length: 1 }, { ...indexed, length: 0 },
      { ...indexed, length: 1.5 }, { ...indexed, session: 'other' },
      { ...indexed, offset: Number.MAX_SAFE_INTEGER, length: 1 },
    ]) {
      expect(validRange(ref, indexed)).toBe(false);
      expect(() => contentSlice(text, ref, indexed)).toThrow('范围不在已索引的正文块内');
    }
  });

  it('先整体脱敏，再处理越界末块与多字节字符', () => {
    const secret = 'fixture-private-content-value';
    const source = text + secret;
    const ref = { ...indexed, length: Buffer.byteLength(source), bytes: Buffer.byteLength(source) };
    const dispose = registerTemporarySecrets([secret]);
    try {
      expect(contentSlice(source, { ...ref, length: ref.length + 3 }, ref)).toBe(text + '[已隐藏]');
    } finally { dispose(); }
  });
});
