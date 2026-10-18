import type { CodexPromptSnapshot, CodexPromptView } from '../../../src/obs/http.js';

class StaleRevisionError extends Error { override name = 'StaleRevisionError'; }

/** 与 CodexPromptStore 同形的内存桩：read / save / subscribe；save 校验 revision、空内容、64 KB 与秘密。 */
export class CodexPromptStub implements CodexPromptView {
  managed = '# 受管规则\n- 只写 /workspace';
  custom: string;
  rev = 1;
  updatedAt: number | null = null;
  saves: { custom: string; expectedRevision: string }[] = [];
  secrets: string[] = [];
  private readonly subs = new Set<(change?: unknown) => void>();
  constructor(custom = '自定义规则') { this.custom = custom; }
  get revision(): string { return `rev-${this.rev}`; }
  async read(): Promise<CodexPromptSnapshot> {
    return { managed: this.managed, custom: this.custom, revision: this.revision, file: '/data/prompts/codex.md', updatedAt: this.updatedAt };
  }
  async save(custom: string, expectedRevision: string): Promise<{ revision: string }> {
    this.saves.push({ custom, expectedRevision });
    if (expectedRevision !== this.revision) throw new StaleRevisionError('stale');
    if (!custom.trim()) throw new Error('codex.md 不能为空');
    if (Buffer.byteLength(custom) > 64 * 1024) throw new Error('codex.md 超过 64 KB 上限');
    if (this.secrets.some(s => custom.includes(s))) throw new Error('codex.md 中包含凭据样式的内容，拒绝保存');
    this.custom = custom; this.rev++; this.updatedAt = Date.now();
    for (const fn of this.subs) fn({ revision: this.revision });
    return { revision: this.revision };
  }
  subscribe(fn: (change?: unknown) => void): () => void { this.subs.add(fn); return () => { this.subs.delete(fn); }; }
  notify(change: unknown): void { for (const fn of this.subs) fn(change); }
  get listeners(): number { return this.subs.size; }
}
