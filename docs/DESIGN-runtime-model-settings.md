# 设计：面板按 agent 配置模型与思考档位（含 auto）

状态：设计完成，待实现。关联：`docs/DESIGN-codex-via-magpie.md`、`docs/DESIGN-pi-via-magpie.md`、`src/agent/settings.ts`（运行时设置 §8.4）。

## 0. 事实（2026-10-19 实测）

- 两个 agent 都已经经 magpie 出站。codex 模型来自 `CODEX_MODEL`（启动固定，受管 config.toml 的 `model`），上下文窗口由 `model-catalog.ts` 按模型名从 magpie 目录（`/v1/codex/models`，缓存 `${CODEX_HOME}/models_cache.json`）解析一次。pi 模型来自 `AGENT_MODEL_PROVIDER/AGENT_MODEL_ID`（启动固定），`PiBackend` 每次提交 `agent = { model, thinkingLevel }`，衰老任务 `aging.ts` 用同一个 `Model` 对象。
- 运行时设置 `settings.json`（`SettingsStore`）现有 `agentBackend`、`backendOverrides`、`codexReasoningEffort`、`alertOwner`；派发器在入队时把 `{ backend, codexReasoningEffort }` 快照进票据（`TicketDoc.settings`），之后的修改不影响已入队票据。
- codex 对 resume 的线程每轮都应用当前设置：owner 线程 10-17 以 `gpt-6-astra` 创建，现在每轮 `thread_settings_applied` 为 `gpt-6.1-sol`/`magpie`。所以 `-c model="…"` 每轮传入即可切模型，不必新建线程。
- 档位枚举：codex 0.163 `ReasoningEffort` 只有 none/minimal/low/medium/high/xhigh/max/ultra，**没有 auto**；pi-ai `ModelThinkingLevel` 为 off/minimal/low/medium/high/xhigh/max，也没有 auto。magpie 目录给出每个模型的 `reasoning_levels`（gpt-6.1-sol：low/medium/high/xhigh/max/ultra；deepseek-flash：none/low/high/max）。
- 可选模型清单都能从 magpie 拿到：codex 侧 `models_cache.json`（目录形状 `{ models: [{ slug, context_window, … }] }`，见 `catalogContextWindow`）；pi 侧启动时注册的 `models.getModels("magpie")`（含 `contextWindow`、`thinkingLevelMap`）。

## 1. 目标与非目标

目标：
1. 设置页为 codex 与 pi 各自选择模型（下拉，来自 magpie 目录），保存后下一条消息生效，不重启、不换线程。
2. 两个 agent 的思考档位都可选 `auto`：按消息难度自动选档，选档结果写进票据快照并在票据页可见。

非目标：按 QQ 会话（群/私聊）配置模型（如需，后续在 `backendOverrides` 的思路上扩展）；非 magpie 提供者下的 pi 模型切换（只显示只读当前值）；magpie 目录的热刷新（仍是启动一次，重启后更新清单）。

## 2. 数据模型

### 2.1 RuntimeSettings 新增

```ts
codexModel: string;          // magpie 目录里的完整 slug（如 "codex/gpt-6.1-sol"），默认 cfg.CODEX_MODEL
codexReasoningEffort: ReasoningEffort | "auto";   // 现有字段放宽
piModel: string;             // AGENT_MODEL_PROVIDER 下的 modelId，默认 cfg.AGENT_MODEL_ID
piThinkingLevel: ModelThinkingLevel | "auto";     // 默认 cfg.AGENT_THINKING_LEVEL
```

校验：`SettingsStore.update` 之外，`settings.ts` 增加可注入的 `validators: { codexModel(slug): boolean; piModel(id): boolean }`，由 main 注入（codex：与 `models_cache.json` 中的 slug 精确相等，或目录不可用时允许安全的非空 slug；pi：`models.getModel(provider, id)` 存在）。老 `settings.json` 缺字段时用 `.env` 默认值补齐（沿用 `FileSettingsSchema.partial()` 的读法）。目录可用时，无效的持久化或环境模型保留原值，告警并在面板标为「不在目录中」；`currentForTurn()` 为新回合选择有效的 `CODEX_MODEL`，环境默认也无效则使用内置 `codex/gpt-6.1-sol`。目录不可用时继续使用配置值。不得自动补前缀：Codex 自身按完整 slug 查元数据，短名会回退到默认窗口与能力。

### 2.2 票据快照 TicketSettings

```ts
{ backend; codexReasoningEffort: ReasoningEffort; codexModel?: string; piModel?: string; piThinkingLevel?: ModelThinkingLevel;
  effortSource?: "fixed" | "auto" | "auto-fallback" }
```

快照里永远是**已解析的具体档位**；`auto` 在派发时解析（§3）。旧票据缺字段时按现有行为（codex 用 `-c` 不传模型即受管 config 的默认；pi 用启动模型）。

## 3. auto 选档

新模块 `src/agent/effort-router.ts`（agent 层）：

```ts
export type AutoEffort = "low" | "medium" | "high" | "xhigh";
export function heuristicEffort(text: string, hints: { hasImages: boolean; hasQuote: boolean }): AutoEffort | undefined; // 纯规则快路径
export async function classifyEffort(deps: { complete(prompt: string, signal: AbortSignal): Promise<string> }, text: string, hints, signal): Promise<AutoEffort>;
export async function resolveAutoEffort(deps, msg, fallback: AutoEffort): Promise<{ effort: AutoEffort; source: "auto" | "auto-fallback" }>;
```

- 快路径（不调模型）：去掉 `[来源]/[引用]` 头与空白后 ≤ 12 字且不含问号、代码符号、"为什么/怎么/如何/帮我/写/改/分析" 等任务词 → `low`；含 "仔细想/深入分析/认真思考/think hard" → `xhigh`。
- 否则调一次分类模型：用 pi 的 `models.completeSimple`，模型取 `AUTO_EFFORT_MODEL`（新配置，默认 `deepseek/deepseek-flash`，须在 `magpie` 提供者下存在；为空则只走快路径+回退），`thinkingLevel: "off"`、`maxTokens: 8`、超时 `AUTO_EFFORT_TIMEOUT_MS=4000`。提示词固定（放在 `DEFAULT_EFFORT_ROUTER_PROMPT`，不进 prompts 目录）：四档定义沿用旧 system.md 的分级——low：闲聊、寒暄、简单问答、查事实；medium：一般解释、小改动、简短翻译/总结；high：多步推理、写代码、调试、长文；xhigh：复杂工程或深度分析、用户明确要求仔细思考。输出只允许四个词之一，其他输出视为失败。
- 失败/超时 → `fallback`（codex 取 `.env` 的 `CODEX_REASONING_EFFORT`（非法则 high），pi 取 `AGENT_THINKING_LEVEL`），`source: "auto-fallback"`。
- 档位映射：codex 直接用；pi 把 AutoEffort 映射 low→low、medium→medium、high→high、xhigh→xhigh 后交给现有 `resolveThinkingLevel(model, level)` 就近收敛（deepseek-flash 没有 medium 会落到 low/high 之一，由 `clampThinkingLevel` 决定）。
- 观测：票据事件 `effort_route`（status ok/fallback，detail `{ effort, source, ms, model }`），不记录消息正文。

派发器（`dispatch.ts` 入队处 / `tasks.snapshotSettings`）：当前后端对应档位为 `auto` 时先 `await resolveAutoEffort`（它自己兜底，不抛），再写快照。auto 带来约 1–2 s 入队延迟，只在选了 auto 时发生。

## 4. 生效路径

- codex：`CodexRunner.turn` 的参数加 `model?: string` → `-c model="<slug>"`；上下文窗口按模型解析：`loadCodexContextWindow` 结果按模型缓存在 runner 内（`Map<model, window>`），`ensure/recordTurn` 用本轮模型的窗口。`tasks.ts` 把快照的 `codexModel` 传给 runner；缺省时不传 `-c model`（受管配置默认）。
- pi：`PiBackend` 每次提交读 `settings.current()` 的 `piModel` 与快照的 `piThinkingLevel`：`agent = { model: { provider, modelId: piModel }, thinkingLevel }`；提交前 `models.getModel` 不存在则回退启动模型并 warn。`aging.ts` 的 `model` 改为 getter（每次运行读当前 piModel 的 `Model`）。
- 设置变更日志沿用 `SETTINGS_TICKET` 的 before/after 记录。

## 5. 设置页（UI）

`/settings` 在"运行时设置"表单里按 agent 分两组：
- codex：模型下拉（选项 = `models_cache.json` 的 slug，附上下文窗口 k 显示；目录不可用时退化为文本框并提示）；思考档位下拉 = `auto` + `REASONING_EFFORTS`。
- pi：模型下拉（`models.getModels(AGENT_MODEL_PROVIDER)`，附窗口；非 magpie 提供者只显示只读当前值）；思考档位下拉 = `auto` + 该模型支持的档位（按 `thinkingLevelMap` 过滤，auto 不过滤）。
- "出站方式"只读区块不变。票据页的派发设置行显示 `模型 / 档位（来源 auto）`。

POST 处理在 `dashboard-post.ts` 的现有 `/settings` 分支加字段；非法值返回现有的 flash 错误。

## 6. 配置

新增 `AUTO_EFFORT_MODEL`（默认 `deepseek/deepseek-flash`）、`AUTO_EFFORT_TIMEOUT_MS`（默认 4000）。`CODEX_MODEL`（默认 `codex/gpt-6.1-sol`）、`AGENT_MODEL_ID`、`CODEX_REASONING_EFFORT`、`AGENT_THINKING_LEVEL` 变成初始默认值（与 `AGENT_BACKEND` 同义）；`AGENT_THINKING_LEVEL` 的 zod 枚举保持不含 auto（auto 只在运行时设置里）。

## 7. 测试

- settings：新字段默认值、校验器拒绝未知模型、旧文件缺字段补默认、`auto` 合法。
- effort-router：快路径样例（寒暄→low、"仔细分析"→xhigh）、分类输出解析（大小写/标点容错、非法输出→fallback）、超时→fallback、事件记录。
- runner：`turn` 传 `model` 时 argv 含 `-c model="…"`，不同模型用各自窗口。
- pi backend：提交用设置里的模型与快照档位；模型不存在时回退并 warn。
- dispatch/tasks：auto 时快照落具体档位且 `effortSource` 正确；fixed 时不调用分类。
- dashboard：设置页渲染两组下拉、POST 合法/非法值；票据页显示来源。

## 8. 验收（主会话）

部署后：面板把 pi 模型切到 `codex/gpt-6.1-sol` 再切回，群消息的 `model_turn` 记录随之变化、magpie 用量 `agent=pi` 的 `req` 对应；codex 模型切 `codex/gpt-6-astra` 后 owner 私聊的 rollout `thread_settings_applied.model` 变化且仍 resume 同一线程、上下文窗口按新模型；两边选 auto 后寒暄消息快照 low（快路径，无分类调用），技术问题快照 high/xhigh 且 `effort_route` 事件有耗时与模型；分类模型不可达时 `auto-fallback` 生效。

## 9. 验收记录

（主会话追加）
