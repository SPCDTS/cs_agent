/**
 * 运行时设置（设计 §8.4）：`${DATA_DIR}/settings.json` 持久化面板可改的项，`.env` 只是初始默认值。
 * 派发器在消息入队前读取 `current()` 并写入票据快照；修改仅影响之后派发的消息。告警开关独立现读。
 * 文件原子写（临时文件 + rename），读写都经 zod 校验；文件损坏时记录告警并回退到 `.env` 默认值（不覆盖坏文件）。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { isScope } from "../context/access.js";
import { log } from "../log.js";
import { trace as defaultTrace, type Trace } from "../obs/trace.js";
import { REASONING_EFFORTS, type ReasoningEffort } from "./codex-runner.js";
import { BACKEND_NAMES, type BackendName } from "./backends/types.js";
import type { ReplyMode } from "./reply-postprocess.js";

export interface RuntimeSettings {
  agentBackend: BackendName;
  backendOverrides: Record<string, BackendName>;
  codexReplyMode: ReplyMode;
  codexReasoningEffort: ReasoningEffort;
  alertOwner: boolean;
}

const backend = z.enum(BACKEND_NAMES);
const SettingsSchema = z.object({
  agentBackend: backend,
  backendOverrides: z.record(z.string().refine(isScope, "scope 必须是 group:<群号> 或 private:<QQ号>"), backend)
    .refine(v => Object.keys(v).length <= 500, "覆盖表最多 500 项"),
  codexReplyMode: z.enum(["relay", "direct"]),
  codexReasoningEffort: z.enum(REASONING_EFFORTS),
  alertOwner: z.boolean(),
}).strict();
const FileSchema = z.object({ version: z.literal(1), settings: SettingsSchema.partial() }).strict();

const SETTINGS_FILE = "settings.json";
/** 记录设置变更的观测票据（以 @ 开头：不进票据列表） */
export const SETTINGS_TICKET = "@settings";

export type SettingsSource = "dashboard" | "test";

/** `.env` 里的 CODEX_REASONING_EFFORT 可能是任意字符串；不在允许列表时取 high。 */
export function settingsDefaults(cfg: {
  AGENT_BACKEND: BackendName; backendOverrides: Record<string, BackendName>; CODEX_REPLY_MODE: ReplyMode;
  CODEX_REASONING_EFFORT: string; ALERT_OWNER: boolean;
}): RuntimeSettings {
  const effort = (REASONING_EFFORTS as readonly string[]).includes(cfg.CODEX_REASONING_EFFORT) ? cfg.CODEX_REASONING_EFFORT as ReasoningEffort : "high";
  return { agentBackend: cfg.AGENT_BACKEND, backendOverrides: { ...cfg.backendOverrides }, codexReplyMode: cfg.CODEX_REPLY_MODE,
    codexReasoningEffort: effort, alertOwner: cfg.ALERT_OWNER };
}

type Listener = (next: Readonly<RuntimeSettings>, before: Readonly<RuntimeSettings>) => void;

export class SettingsStore {
  private value: RuntimeSettings;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<Listener>();
  readonly file: string;

  private constructor(dataDir: string, readonly defaults: Readonly<RuntimeSettings>, initial: RuntimeSettings, private readonly trace: Trace) {
    this.file = path.join(dataDir, SETTINGS_FILE);
    this.value = initial;
  }

  /** 读取持久化设置并覆盖默认值；文件不存在 → 默认值。 */
  static async open(dataDir: string, defaults: RuntimeSettings, trace: Trace = defaultTrace): Promise<SettingsStore> {
    const base = SettingsSchema.parse(defaults);
    let initial = base;
    const file = path.join(dataDir, SETTINGS_FILE);
    try {
      const st = await fs.lstat(file);
      if (!st.isFile() || st.size > 256 * 1024) throw new Error("settings.json 不是普通文件或过大");
      const parsed = FileSchema.parse(JSON.parse(await fs.readFile(file, "utf8")));
      initial = SettingsSchema.parse({ ...base, ...parsed.settings });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") log.warn("settings.json invalid; using .env defaults", { error: err instanceof Error ? err.message : String(err) });
    }
    return new SettingsStore(dataDir, base, initial, trace);
  }

  /** 当前生效值（每条消息现读）。返回冻结副本，调用方不能就地修改。 */
  current(): Readonly<RuntimeSettings> {
    return Object.freeze({ ...this.value, backendOverrides: Object.freeze({ ...this.value.backendOverrides }) }) as Readonly<RuntimeSettings>;
  }

  subscribe(fn: Listener): () => void { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }

  /** 校验 → 原子落盘 → 生效 → 记观测事件。串行化，落盘失败时不生效。 */
  update(patch: Partial<RuntimeSettings>, source: SettingsSource): Promise<Readonly<RuntimeSettings>> {
    const run = this.chain.then(async () => {
      const before = this.current();
      const next = SettingsSchema.parse({ ...this.value, ...patch });
      await this.write(next);
      this.value = next;
      const after = this.current();
      const changed = (Object.keys(next) as (keyof RuntimeSettings)[]).filter(k => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
      if (changed.length) {
        this.trace.event(SETTINGS_TICKET, "settings_changed", { detail: { source, changed,
          before: Object.fromEntries(changed.map(k => [k, before[k]])), after: Object.fromEntries(changed.map(k => [k, after[k]])) } });
        log.info("runtime settings changed", { source, changed });
        for (const fn of this.listeners) { try { fn(after, before); } catch { /* 订阅者错误不影响保存 */ } }
      }
      return after;
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async write(value: RuntimeSettings): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(tmp, JSON.stringify({ version: 1, settings: value }, null, 2) + "\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
      await fs.rename(tmp, this.file);
    } finally { await fs.rm(tmp, { force: true }).catch(() => undefined); }
  }
}

export const formatBackendOverrides = (o: Readonly<Record<string, BackendName>>) =>
  Object.entries(o).map(([k, v]) => `${k}=${v}`).join("\n");
