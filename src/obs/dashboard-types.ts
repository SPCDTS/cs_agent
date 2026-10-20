/** 面板组合接口；页面仅接收 dashboard-pages 定义的只读数据视图。 */
import type { Config } from '../config.js';
import type { SkillsStore } from '../agent/skills-store.js';
import type { ContextStore } from '../context/store.js';
import type { ObsStore } from './store.js';
import type { SessionAdapters } from './sessions/http.js';
import type { PiSessionSource } from '../agent/backends/pi-session-types.js';
import type { MemoryAging, MemoryArchives } from './memory/types.js';
import type { SettingsStore } from '../agent/settings.js';
import type { LiveBus } from './live.js';
import type { ThreadKey } from '../agent/backends/types.js';
import type { Trace } from '../shared/trace.js';
import type { ContextUsageView } from '../shared/format.js';
import type { CodexBasePromptSnapshot, ModelCatalogView } from './ui/dashboard-pages.js';
import type { ScheduleManagement } from './schedules.js';

export interface DashboardOptions {
  schedules?: ScheduleManagement;
  /** 共享技能管理；off 时不注入。页面使用 list/readSkillMd/files。 */
  skills?: SkillsStore;
  config: Config; store: ObsStore; context: ContextStore;
  health: () => unknown | Promise<unknown>; queue: () => unknown;
  codex: () => Promise<unknown>; pi: () => Promise<unknown>;
  /** pi-durable 的只读公开接口；同时为后续历史上下文分析保留 context(at)。 */
  piSessions?: PiSessionSource;
  /** 可注入适配器，便于测试或其它宿主复用相同鉴权与路由。 */
  sessionAdapters?: SessionAdapters;
  aging?: MemoryAging;
  archives?: MemoryArchives;
  /** 运行时设置（/settings 可写）；缺省时设置页只读展示配置 */
  settings?: SettingsStore;
  /** 进行中会话的实时总线（/live） */
  live?: LiveBus;
  resetCodex?: (key: ThreadKey) => Promise<string | null>;
  resetPi?: (key: string) => Promise<number | null>;
  compactCodex?: (key: ThreadKey) => Promise<'compacted' | 'unchanged'>;
  compactPi?: (key: string) => Promise<'compacted' | 'unchanged'>;
  trace?: Pick<Trace, 'event'>;
  /** 每线程上下文占用（src/agent/context-usage.ts 的 ContextUsageStore；面板只读 all/get） */
  contextUsage?: ContextUsageView;
  /** codex 系统提示（src/agent/codex/prompt.ts 的 CodexPromptStore）：受管段只读，自定义段 codex.md 可编辑 */
  codexPrompt?: CodexPromptView;
  codexBasePrompt?: CodexBasePromptView;
  /** 设置页模型下拉的可选清单（启动时读一次）；缺省或为空时 codex 退化为文本框 */
  modelCatalog?: ModelCatalogView;
}

/** 基础指令存储契约；保存、恢复均绑定页面中的模型与版本。 */
export interface CodexBasePromptView {
  readonly managed: string;
  read(model: string): Promise<CodexBasePromptSnapshot | undefined>;
  save(model: string, custom: string, expectedRevision: string): Promise<{ revision: string }>;
  restore(model: string, expectedRevision: string): Promise<{ revision: string }>;
  subscribe(fn: (change: { model: string; file: string; revision: string; bytes_before: number; bytes_after: number }) => void): () => void;
}

/** CodexPromptStore 的结构类型：面板只依赖这三个方法。 */
export interface CodexPromptSnapshot { managed: string; custom: string; revision: string; file: string; updatedAt: number | null }
export interface CodexPromptView {
  read(): Promise<CodexPromptSnapshot>;
  /** 版本不符抛 name === 'StaleRevisionError'；含秘密 / 超限 / 为空抛带中文说明的普通错误 */
  save(custom: string, expectedRevision: string): Promise<{ revision: string }>;
  subscribe(fn: (change?: unknown) => void): (() => void) | void;
}
