/** 面板组合接口；页面仅接收 dashboard-pages 定义的只读数据视图。 */
import type { Config } from '../config.js';
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

export interface DashboardOptions {
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
  trace?: Pick<Trace, 'event'>;
  /** 每线程上下文占用（src/agent/context-usage.ts 的 ContextUsageStore；面板只读 all/get） */
  contextUsage?: ContextUsageView;
  /** codex 系统提示（src/agent/codex/prompt.ts 的 CodexPromptStore）：受管段只读，自定义段 codex.md 可编辑 */
  codexPrompt?: CodexPromptView;
}

/** CodexPromptStore 的结构类型：面板只依赖这三个方法。 */
export interface CodexPromptSnapshot { managed: string; custom: string; revision: string; file: string; updatedAt: number | null }
export interface CodexPromptView {
  read(): Promise<CodexPromptSnapshot>;
  /** 版本不符抛 name === 'StaleRevisionError'；含秘密 / 超限 / 为空抛带中文说明的普通错误 */
  save(custom: string, expectedRevision: string): Promise<{ revision: string }>;
  subscribe(fn: (change?: unknown) => void): (() => void) | void;
}
