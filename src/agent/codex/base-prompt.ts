import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { log } from "../../shared/log.js";

export const CODEX_BASE_PROMPT_MAX_BYTES = 64 * 1024;
export const MANAGED_QQ_INSTRUCTIONS = `<!-- cs-agent-base-instructions v1: MANAGED -->
## QQ 回复规则（优先于任何工具说明，包括 web.run 的引用格式要求）

回复必须调用 send_message 发出，直接输出的文字用户看不到；send_message 的内容会原样显示在 QQ，QQ 不渲染 Markdown。绝不在回复里写链接、网址、引用标记或来源脚注，包括 [文字](网址)、([站名](网址))、[详情](网址) 等任何形式；检索结果只用自己的话写结论。只有用户明确要求来源时才给，且只给 1 条纯网址。`;

interface BasePromptOptions {
  dataDir: string;
  codexHome: string;
  /** 仅 magpie 提供者注入；URL 与 entrypoint 的 model_catalog_url 同源。 */
  magpieUrl?: string;
  magpieKey?: string;
  containsSecret: (text: string) => boolean;
}

export interface CodexBasePromptSnapshot {
  model: string;
  custom: string;
  managed: string;
  revision: string;
  file: string;
  updatedAt: number;
  /** null 表示暂时无法取得目录模板，不把离线误报为不同。 */
  differs: boolean | null;
}

export interface CodexBasePromptChange {
  target: "codex-base";
  model: string;
  file: string;
  revision: string;
  bytes_before: number;
  bytes_after: number;
}

class BasePromptError extends Error {
  constructor(message: string, readonly status = 409) { super(message); }
}

/** 拒绝路径与设备名；转义下划线及大写，避免分隔符碰撞和 Windows 大小写别名。 */
export function basePromptFilename(slug: string): string {
  const segments = slug.split("/");
  if (!slug || segments.some(s => !/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(s)
      || s.includes("..") || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(s))) {
    throw new BasePromptError("非法的 codex 模型 slug", 400);
  }
  const name = slug.replace(/[_A-Z/]/g, c => c === "/" ? "__" : `~${c.charCodeAt(0).toString(16)}`);
  if (name.length > 200) throw new BasePromptError("codex 模型 slug 过长", 400);
  return `${name}.md`;
}

/** 不使用 base_instructions：它只是目录中的回退提示，不能替代完整模板。 */
function catalogTemplate(catalog: unknown, model: string): string | undefined {
  const models = (catalog as { models?: { slug?: string; model_messages?: { instructions_template?: unknown } }[] } | null)?.models;
  if (!Array.isArray(models)) return undefined;
  const text = models.find(m => m?.slug === model)?.model_messages?.instructions_template;
  return typeof text === "string" && text.trim() ? text : undefined;
}

async function directory(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const st = await fs.lstat(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new BasePromptError("基础指令目录不可为链接");
}

/** 首次播种用 link 原子发布且不覆盖；后续保存用同目录 rename。 */
async function writeAtomic(file: string, text: string, seed = false): Promise<void> {
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, text, { encoding: "utf8", flag: "wx", mode: 0o600 });
    if (seed) await fs.link(tmp, file).catch((e: NodeJS.ErrnoException) => { if (e.code !== "EEXIST") throw e; });
    else await fs.rename(tmp, file);
  } finally { await fs.rm(tmp, { force: true }).catch(() => undefined); }
}

/** 按模型保存完整基础指令；已播种文件永不随目录刷新自动覆盖。 */
export class CodexBasePromptStore {
  readonly managed = MANAGED_QQ_INSTRUCTIONS;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly warned = new Set<string>();
  private readonly listeners = new Set<(change: CodexBasePromptChange) => void>();

  constructor(private readonly options: BasePromptOptions) {}

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async template(model: string): Promise<string | undefined> {
    try {
      const cached = catalogTemplate(JSON.parse(await fs.readFile(path.join(this.options.codexHome, "models_cache.json"), "utf8")), model);
      if (cached) return cached;
    } catch { /* 缓存缺失或损坏时尝试提供者目录。 */ }
    if (!this.options.magpieUrl) return undefined;
    try {
      const response = await fetch(`${this.options.magpieUrl.replace(/\/+$/, "")}/codex/models`, {
        headers: { "x-openai-actor-authorization": "cs-agent",
          ...(this.options.magpieKey ? { Authorization: `Bearer ${this.options.magpieKey}` } : {}) },
        signal: AbortSignal.timeout(5000), redirect: "error",
      });
      if (response.ok) return catalogTemplate(await response.json(), model);
      await response.body?.cancel();
    } catch { /* 不记录 URL、密钥或服务端正文；调用方按模型去重告警。 */ }
    return undefined;
  }

  private missing(model: string): void {
    if (this.warned.has(model)) return;
    this.warned.add(model);
    log.warn("codex base instructions template unavailable; using codex defaults", { model });
  }

  private async readFile(model: string): Promise<Omit<CodexBasePromptSnapshot, "differs"> | undefined> {
    const name = basePromptFilename(model);
    await directory(path.join(this.options.dataDir, "prompts"));
    const dir = path.join(this.options.dataDir, "prompts", "codex-base");
    await directory(dir);
    const file = path.join(dir, name);
    const st = await fs.lstat(file).catch((e: NodeJS.ErrnoException) => { if (e.code !== "ENOENT") throw e; });
    if (!st) return undefined;
    if (!st.isFile() || st.isSymbolicLink()) throw new BasePromptError("基础指令不是普通文件");
    if (st.size > 256 * 1024) throw new BasePromptError("基础指令过大，无法安全读取");
    const handle = await fs.open(file, "r");
    try {
      const stat = await handle.stat(), bytes = await handle.readFile();
      let custom: string;
      try { custom = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
      catch { throw new BasePromptError("基础指令必须使用 UTF-8 编码，请先在本地转换"); }
      // 内容摘要也参与版本，避免文件大小与 mtime 相同的外部编辑漏检。
      const revision = createHash("sha256").update(`${stat.mtimeMs}:`).update(bytes).digest("hex").slice(0, 24);
      return { model, custom, managed: this.managed, revision, file, updatedAt: stat.mtimeMs };
    } finally { await handle.close(); }
  }

  private async seed(model: string, template: string | undefined): Promise<void> {
    if (!template) { this.missing(model); return; }
    this.validate(template);
    await writeAtomic(path.join(this.options.dataDir, "prompts", "codex-base", basePromptFilename(model)), template, true);
  }

  read(model: string): Promise<CodexBasePromptSnapshot | undefined> {
    return this.enqueue(async () => {
      let snapshot = await this.readFile(model);
      const template = await this.template(model);
      if (!snapshot) { await this.seed(model, template); snapshot = await this.readFile(model); }
      return snapshot && { ...snapshot, differs: template === undefined ? null : snapshot.custom !== template };
    });
  }

  subscribe(fn: (change: CodexBasePromptChange) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private validate(text: string): void {
    if (!text.trim()) throw new BasePromptError("基础指令不能为空");
    if (Buffer.byteLength(text, "utf8") > CODEX_BASE_PROMPT_MAX_BYTES) throw new BasePromptError("基础指令超过 64 KB 上限");
    if (this.options.containsSecret(text)) throw new BasePromptError("基础指令包含凭据样式的内容，禁止保存。");
  }

  private update(model: string, expectedRevision: string, custom?: string): Promise<{ revision: string }> {
    return this.enqueue(async () => {
      const before = await this.readFile(model);
      if (!before || before.revision !== expectedRevision) throw new BasePromptError("基础指令已在别处被修改，请刷新页面后再保存。");
      if (this.options.containsSecret(before.custom)) throw new BasePromptError("基础指令中包含凭据样式的内容，面板禁止覆盖；请在本地直接编辑。");
      let text: string;
      if (custom === undefined) {
        const template = await this.template(model);
        if (template === undefined) throw new BasePromptError("目录模板暂不可用，基础指令未更改。");
        text = template; // 恢复必须与目录逐字一致，包括 BOM 与换行。
      } else {
        const bom = before.custom.startsWith("\uFEFF") ? "\uFEFF" : "";
        const newline = before.custom.match(/\r\n|\n|\r/)?.[0] ?? "\n";
        text = bom + custom.replace(/^\uFEFF/, "").replace(/\r\n|\r|\n/g, newline);
      }
      this.validate(text);
      if (text !== before.custom) await writeAtomic(before.file, text);
      const after = (await this.readFile(model))!;
      const change: CodexBasePromptChange = { target: "codex-base", model, file: after.file, revision: after.revision,
        bytes_before: Buffer.byteLength(before.custom, "utf8"), bytes_after: Buffer.byteLength(text, "utf8") };
      for (const fn of this.listeners) { try { fn({ ...change }); } catch { /* 观测不影响保存。 */ } }
      return { revision: after.revision };
    });
  }

  save(model: string, custom: string, expectedRevision: string): Promise<{ revision: string }> {
    return this.update(model, expectedRevision, custom);
  }

  restore(model: string, expectedRevision: string): Promise<{ revision: string }> {
    return this.update(model, expectedRevision);
  }

  /** 每轮现读；已有编辑文件时不依赖目录联网。有效文件不变则保留 mtime。 */
  prepare(model: string): Promise<string | undefined> {
    return this.enqueue(async () => {
      let snapshot = await this.readFile(model);
      if (!snapshot) { await this.seed(model, await this.template(model)); snapshot = await this.readFile(model); }
      if (!snapshot) return undefined;
      const dir = path.join(this.options.codexHome, "base-instructions");
      await directory(dir);
      const file = path.join(dir, basePromptFilename(model));
      const content = `${snapshot.custom}\n\n${this.managed}`;
      const st = await fs.lstat(file).catch((e: NodeJS.ErrnoException) => { if (e.code !== "ENOENT") throw e; });
      if (st && (!st.isFile() || st.isSymbolicLink())) throw new BasePromptError("生效基础指令不是普通文件");
      if (!st || st.size !== Buffer.byteLength(content, "utf8") || await fs.readFile(file, "utf8") !== content) {
        await writeAtomic(file, content);
      }
      return file;
    });
  }
}
