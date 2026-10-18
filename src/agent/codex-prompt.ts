import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { DEFAULT_CODEX_PROMPT, renderManagedAgentsMd, type AgentsMdOptions } from "./codex-runner.js";

export { DEFAULT_CODEX_PROMPT } from "./codex-runner.js";
export const CODEX_PROMPT_MAX_BYTES = 64 * 1024;

export interface CodexPromptOptions extends AgentsMdOptions {
  codexHome: string;
  /** 由调用方注入 obs 脱敏注册表的判定函数，数据层不依赖观测模块。 */
  containsSecret: (text: string) => boolean;
}

export interface CodexPromptSnapshot {
  managed: string;
  custom: string;
  revision: string;
  file: string;
  updatedAt: number | null;
}

export interface CodexPromptChange {
  target: "codex";
  file: string;
  revision: string;
  bytes_before: number;
  bytes_after: number;
}

export class CodexPromptError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "CodexPromptError";
  }
}

export class StaleRevisionError extends CodexPromptError {
  constructor() {
    super("codex.md 已在别处被修改，请刷新页面查看最新内容后再保存。", 409);
    this.name = "StaleRevisionError";
  }
}

const revisionOf = (st: { mtimeMs: number; size: number }): string =>
  createHash("sha256").update(`${st.mtimeMs}:${st.size}`).digest("hex").slice(0, 16);

/** 临时文件与目标在同一目录，rename 原子发布；失败时清理临时文件。 */
async function writeAtomic(file: string, content: string): Promise<void> {
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await fs.rename(tmp, file);
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
  }
}

/** codex 提示词的数据层：现读自定义文件，串行保存并立即重新生成全局规则。 */
export class CodexPromptStore {
  readonly file: string;
  readonly agentsFile: string;
  private readonly managed: string;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<(change: CodexPromptChange) => void>();

  constructor(private readonly options: CodexPromptOptions) {
    this.file = path.join(options.dataDir, "prompts", "codex.md");
    this.agentsFile = path.join(options.codexHome, "AGENTS.md");
    this.managed = renderManagedAgentsMd(options);
  }

  /** 缺失时只播种一次；拒绝链接目录，避免面板写到提示词目录之外。 */
  private async ensureDefault(): Promise<void> {
    const dir = path.dirname(this.file);
    await fs.mkdir(dir, { recursive: true });
    const st = await fs.lstat(dir);
    if (!st.isDirectory() || st.isSymbolicLink()) throw new CodexPromptError("prompts 目录不可为链接");
    await fs.writeFile(this.file, DEFAULT_CODEX_PROMPT, { encoding: "utf8", flag: "wx", mode: 0o600 })
      .catch((err: NodeJS.ErrnoException) => { if (err.code !== "EEXIST") throw err; });
  }

  async read(): Promise<CodexPromptSnapshot> {
    await this.ensureDefault();
    const st = await fs.lstat(this.file);
    if (!st.isFile() || st.isSymbolicLink()) throw new CodexPromptError("codex.md 不是普通文件");
    if (st.size > 256 * 1024) throw new CodexPromptError("codex.md 过大，无法安全读取");
    // 同一文件描述符读取内容与时间戳，避免原子替换导致内容和 revision 对不上。
    const handle = await fs.open(this.file, "r");
    try {
      const stat = await handle.stat();
      const bytes = await handle.readFile();
      let custom: string;
      try { custom = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
      catch { throw new CodexPromptError("codex.md 必须使用 UTF-8 编码，请先在本地转换"); }
      return { managed: this.managed, custom, revision: revisionOf(stat), file: this.file, updatedAt: stat.mtimeMs };
    } finally { await handle.close(); }
  }

  subscribe(fn: (change: CodexPromptChange) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  save(custom: string, expectedRevision: string): Promise<{ revision: string }> {
    return this.enqueue(async () => {
      const before = await this.read();
      if (this.options.containsSecret(before.custom)) {
        throw new CodexPromptError("codex.md 中包含凭据样式的内容，面板禁止覆盖；请在本地直接编辑。", 409);
      }
      if (before.revision !== expectedRevision) throw new StaleRevisionError();
      if (!custom.trim()) throw new CodexPromptError("codex.md 不能为空");
      // 保留已有 UTF-8 BOM 与换行风格，兼容浏览器表单提交的 CRLF。
      const bom = before.custom.startsWith("\uFEFF") ? "\uFEFF" : "";
      const newline = before.custom.match(/\r\n|\n|\r/)?.[0] ?? "\n";
      const text = bom + custom.replace(/^\uFEFF/, "").replace(/\r\n|\r|\n/g, newline);
      const bytes = Buffer.byteLength(text, "utf8");
      if (bytes > CODEX_PROMPT_MAX_BYTES) throw new CodexPromptError("codex.md 超过 64 KB 上限");
      if (this.options.containsSecret(text)) throw new CodexPromptError("提交内容包含凭据样式的内容，禁止保存。", 409);
      await writeAtomic(this.file, text);
      await this.regenerateCurrent();
      const after = await this.read();
      const change: CodexPromptChange = { target: "codex", file: this.file, revision: after.revision,
        bytes_before: Buffer.byteLength(before.custom, "utf8"), bytes_after: bytes };
      for (const fn of this.listeners) {
        try { fn({ ...change }); } catch { /* 观测订阅者不能使已完成的保存失败。 */ }
      }
      return { revision: after.revision };
    });
  }

  /** 与 save 共用生成逻辑；排队防止启动或显式再生成覆盖较新的保存。 */
  regenerate(): Promise<void> { return this.enqueue(() => this.regenerateCurrent()); }

  private async regenerateCurrent(): Promise<void> {
    const { managed, custom } = await this.read();
    await fs.mkdir(path.dirname(this.agentsFile), { recursive: true });
    await writeAtomic(this.agentsFile, `${managed}\n\n${custom}`);
  }
}
