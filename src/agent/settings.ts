/**
 * 运行时设置（docs/DASHBOARD.md §2.1）：`${DATA_DIR}/settings.json` 持久化面板可改的项，`.env` 只是初始默认值。
 * 派发器在入队前冻结后端、档位与模型记录；Pi 模型在提交时现读，告警开关独立现读。
 * 文件原子写（临时文件 + rename），读写都经 zod 校验；文件损坏时记录告警并回退到 `.env` 默认值（不覆盖坏文件）。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { z } from "zod";
import { DEFAULT_CODEX_MODEL } from "../config.js";
import { DEFAULT_SEND_RULES, type SendRuleLimits } from "../channel/send-rules.js";
import { isScope } from "../context/access.js";
import { log } from "../shared/log.js";
import { trace as defaultTrace, type Trace } from "../shared/trace.js";
import { REASONING_EFFORTS } from "./codex/runner.js";
import { type ReasoningEffort } from "./backends/types.js";
import { BACKEND_NAMES, type BackendName } from "./backends/types.js";

export interface RuntimeSettings {
  agentBackend: BackendName;
  backendOverrides: Record<string, BackendName>;
  codexModel: string;
  codexReasoningEffort: ReasoningEffort | "auto";
  piModel: string;
  piThinkingLevel: ModelThinkingLevel | "auto";
  alertOwner: boolean;
  /** bridge 出站发送规则（docs/ARCHITECTURE.md §3.3），每次发送前现读 */
  sendRules: SendRuleLimits;
}

export interface SettingsValidators {
  codexModel(slug: string): boolean;
  piModel(id: string): boolean;
}

const backend = z.enum(BACKEND_NAMES);
const count = (max: number) => z.number().int().min(1).max(max);
const SendRulesSchema = z.object({
  perChatMinute: count(600), perChatHour: count(36_000), chatBreakerMinutes: count(1440),
  globalMinute: count(6000), globalBreakerMinutes: count(1440),
}).strict();
const SettingsSchema = z.object({
  agentBackend: backend,
  backendOverrides: z.record(z.string().refine(isScope, "scope 必须是 group:<群号> 或 private:<QQ号>"), backend)
    .refine(v => Object.keys(v).length <= 500, "覆盖表最多 500 项"),
  codexModel: z.string().regex(/^[A-Za-z0-9._/-]+$/, "模型 slug 含非法字符"),
  codexReasoningEffort: z.enum([...REASONING_EFFORTS, "auto"]),
  piModel: z.string().trim().min(1),
  piThinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"]),
  alertOwner: z.boolean(),
  sendRules: SendRulesSchema,
}).strict();
// 只在读取旧文件时剥离已移除的字段；其余未知键及运行时更新仍严格校验。发送规则逐项缺省为默认值。
const FileSettingsSchema = SettingsSchema.partial().extend({ codexReplyMode: z.unknown().optional(), sendRules: SendRulesSchema.partial().optional() })
  .transform(({ codexReplyMode: _legacy, ...settings }) => settings);
const FileSchema = z.object({ version: z.literal(1), settings: FileSettingsSchema }).strict();

const SETTINGS_FILE = "settings.json";
/** 记录设置变更的 trace 键（以 @ 开头：系统事件，不进回合列表） */
export const SETTINGS_KEY = "@settings";

export type SettingsSource = "dashboard" | "test";

/** `.env` 里的 CODEX_REASONING_EFFORT 可能是任意字符串；不在允许列表时取 high。 */
export function settingsDefaults(cfg: {
  AGENT_BACKEND: BackendName; backendOverrides: Record<string, BackendName>;
  CODEX_REASONING_EFFORT: string; ALERT_OWNER: boolean;
  CODEX_MODEL: string; AGENT_MODEL_ID: string; AGENT_THINKING_LEVEL: ModelThinkingLevel;
}): RuntimeSettings {
  const effort = (REASONING_EFFORTS as readonly string[]).includes(cfg.CODEX_REASONING_EFFORT) ? cfg.CODEX_REASONING_EFFORT as ReasoningEffort : "high";
  return { agentBackend: cfg.AGENT_BACKEND, backendOverrides: { ...cfg.backendOverrides },
    codexModel: cfg.CODEX_MODEL, codexReasoningEffort: effort, piModel: cfg.AGENT_MODEL_ID,
    piThinkingLevel: cfg.AGENT_THINKING_LEVEL, alertOwner: cfg.ALERT_OWNER, sendRules: { ...DEFAULT_SEND_RULES } };
}

type Listener = (next: Readonly<RuntimeSettings>, before: Readonly<RuntimeSettings>) => void;

export class SettingsStore {
  private value: RuntimeSettings;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<Listener>();
  readonly file: string;

  private constructor(dataDir: string, readonly defaults: Readonly<RuntimeSettings>, initial: RuntimeSettings, private readonly trace: Trace, private readonly validators?: SettingsValidators) {
    this.file = path.join(dataDir, SETTINGS_FILE);
    this.value = initial;
  }

  /** 读取持久化设置并覆盖默认值；文件不存在 → 默认值。 */
  static async open(dataDir: string, defaults: RuntimeSettings, trace: Trace = defaultTrace, validators?: SettingsValidators): Promise<SettingsStore> {
    const base = SettingsSchema.parse(defaults);
    let initial = base;
    const file = path.join(dataDir, SETTINGS_FILE);
    try {
      const st = await fs.lstat(file);
      if (!st.isFile() || st.size > 256 * 1024) throw new Error("settings.json 不是普通文件或过大");
      const parsed = FileSchema.parse(JSON.parse(await fs.readFile(file, "utf8")));
      initial = SettingsSchema.parse({ ...base, ...parsed.settings, sendRules: { ...base.sendRules, ...parsed.settings.sendRules } });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") log.warn("settings.json invalid; using .env defaults", { error: err instanceof Error ? err.message : String(err) });
    }
    const store = new SettingsStore(dataDir, base, initial, trace, validators);
    if (validators && !validators.codexModel(initial.codexModel)) {
      log.warn("codex model not in catalog; using default for turns", {
        model: initial.codexModel, fallback: store.currentForTurn().codexModel,
      });
    }
    return store;
  }

  /** 当前配置原值（含不在目录中的模型，供面板显示）。返回冻结副本，调用方不能就地修改。 */
  current(): Readonly<RuntimeSettings> {
    return Object.freeze({ ...this.value, backendOverrides: Object.freeze({ ...this.value.backendOverrides }),
      sendRules: Object.freeze({ ...this.value.sendRules }) }) as Readonly<RuntimeSettings>;
  }

  /** 回合快照：目录可用时无效模型回退到 CODEX_MODEL；环境默认也无效则用内置默认，不改配置。 */
  currentForTurn(): Readonly<RuntimeSettings> {
    const current = this.current();
    if (!this.validators || this.validators.codexModel(current.codexModel)) return current;
    const codexModel = this.validators.codexModel(this.defaults.codexModel) ? this.defaults.codexModel : DEFAULT_CODEX_MODEL;
    return Object.freeze({ ...current, codexModel });
  }

  subscribe(fn: Listener): () => void { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }

  /** 校验 → 原子落盘 → 生效 → 记观测事件。串行化，落盘失败时不生效。 */
  update(patch: Partial<RuntimeSettings>, source: SettingsSource): Promise<Readonly<RuntimeSettings>> {
    const run = this.chain.then(async () => {
      const before = this.current();
      const next = SettingsSchema.parse({ ...this.value, ...patch });
      for (const field of ["codexModel", "piModel"] as const) {
        if (this.validators && !this.validators[field](next[field])) {
          throw new z.ZodError([{ code: "custom", path: [field], message: "模型不在可用目录中" }]);
        }
      }
      await this.write(next);
      this.value = next;
      const after = this.current();
      const changed = (Object.keys(next) as (keyof RuntimeSettings)[]).filter(k => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
      if (changed.length) {
        this.trace.event(SETTINGS_KEY, "settings_changed", { detail: { source, changed,
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
