# 设计：pi 后端经 magpie 出站

状态：设计完成，待实现。关联：`docs/DESIGN-codex-via-magpie.md`（codex 已切换）。

## 0. 事实（2026-10-19 实测）

- pi 侧现状：`createAgentModels` 直接用 pi-ai 1.3.0 的 `builtinModels()`；`AGENT_MODEL_PROVIDER=deepseek` 走内置 `deepseek` 提供者，baseUrl 写死 `https://api.deepseek.com`，chat/completions，鉴权 `DEEPSEEK_API_KEY`（`.env` 别名 `DEEPSEEK_APIKEY`）。本次 magpie 改造没有碰 pi。
- 用 pi 模型的地方：`PiBackend`（`AGENT_BACKEND=pi` 或 `AGENT_BACKEND_OVERRIDES` 命中的会话）、`context/aging.ts` 的衰老摘要（`models.completeSimple`）。当前 `.env` 没有 pi 覆盖，衰老任务是实际使用者。
- `pi-tools/web.ts` 的联网检索调 `https://api.deepseek.com/v1/tools/{search,page}`，这是 DeepSeek 专有接口，magpie 不代理（`/v1/tools/search` 返回 404）。它继续直连，`DEEPSEEK_API_KEY` 因此保留。
- magpie（宿主机 3425）：gateway key `cs-agent` 已由用户放宽到 `deepseek/*` + `codex/*`。`GET /v1/models` 带 key 列出 `deepseek/deepseek-flash`、`codex/gpt-6.1-sol`、`codex/gpt-6-astra`，每项带 `context_window`、`max_output_tokens`、`reasoning`、`reasoning_levels`、`modalities.input`、`native_endpoints`、`owned_by`。实测：`deepseek/deepseek-flash` 经 `/v1/chat/completions` 正常回包且保留 `reasoning_content`；`codex/gpt-6.1-sol` 经 `/v1/chat/completions`（magpie 翻译到 Responses）和 `/v1/responses` 都能回答。用量记录按 `callerKeyName=cs-agent` 归集，deepseek 请求显示 `provider=deepseek host=api.deepseek.com`。
- pi-ai 1.3.0 提供 `createProvider({ id, baseUrl, auth, models, api })`（`@earendil-works/pi-ai/models`），`api` 可按 `model.api` 给映射；`openAICompletionsApi` / `openAIResponsesApi` 在 `@earendil-works/pi-ai/api/openai-completions.lazy` / `openai-responses.lazy`；`envApiKeyAuth(name, envVars)` 在 `@earendil-works/pi-ai/auth/helpers`；`builtinModels()` 返回 `MutableModels`，有 `setProvider()`。内置 `deepseek-flash` 定义带 `thinkingLevelMap`、`compat`（`thinkingFormat: "deepseek"`、`requiresReasoningContentOnAssistantMessages: true` 等）、`cost`、`inputLimits`，经 magpie 时这些仍然成立，必须继承。

## 1. 目标与非目标

目标：pi 后端（含衰老摘要）的模型调用全部经宿主机 magpie 出站，复用 `CODEX_MAGPIE_URL` / `CODEX_MAGPIE_KEY`；`AGENT_MODEL_ID` 可以是 key 开放的任一 magpie 模型（`deepseek/deepseek-flash`、`codex/gpt-6.1-sol`、…）。
非目标：联网检索工具改道（magpie 不代理）；pi 的 ComfyUI 生图；仪表盘读 magpie 用量。

## 2. 方案

### 2.1 新模块 `src/agent/magpie-models.ts`（agent 层）

```ts
export interface MagpieCatalogEntry { id: string; display_name?: string; owned_by?: string; context_window?: number; max_output_tokens?: number; reasoning?: boolean; reasoning_levels?: string[]; modalities?: { input?: string[] }; native_endpoints?: string[] }
export function magpieProviderModels(entries: MagpieCatalogEntry[], builtin: Models): ProviderModel<"openai-completions" | "openai-responses">[]
export async function fetchMagpieCatalog(baseUrl: string, apiKey: string, fetchImpl?: typeof fetch): Promise<MagpieCatalogEntry[]>   // GET {baseUrl}/models，Bearer，30 s 超时
export function createMagpieProvider(opts: { baseUrl: string; models: ProviderModel[] }): Provider
```

映射规则（纯函数，可单测）：
- `id` 原样（含 `owner/` 前缀，与 magpie 一致）；`name = display_name ?? id`。
- `api`：`native_endpoints` 含 `/v1/responses` 且 `owned_by === "codex"` → `openai-responses`；否则 `openai-completions`。
- 若 `owned_by` 对应 pi-ai 内置提供者且 `builtin.getModel(owned_by, id 去掉前缀)` 存在，则继承该内置模型的 `thinkingLevelMap`、`compat`、`cost`、`promptCache`、`inputLimits`、`input`；`contextWindow`/`maxTokens` 以 magpie 返回值优先（缺失才用内置）。
- 否则：`contextWindow = context_window`、`maxTokens = max_output_tokens`（缺失用 128000 / 32768 并 warn）、`reasoning = !!reasoning`、`input = modalities.input ∩ {text,image}`（缺失 `["text"]`）、`cost` 全 0，`thinkingLevelMap` 由 `reasoning_levels` 推导：pi 档位 off/minimal/low/medium/high/xhigh/max 中名称在列表里的映射为同名，`off` 映射 `"none"`（若有），其余为 `null`（交给 `clampThinkingLevel` 就近）。
- 提供者：`createProvider({ id: "magpie", name: "magpie", baseUrl, auth: { apiKey: envApiKeyAuth("magpie gateway key", ["CODEX_MAGPIE_KEY"]) }, models, api: { "openai-completions": openAICompletionsApi(), "openai-responses": openAIResponsesApi() } })`。不加 `x-openai-actor-authorization`（pi 不需要）。

### 2.2 `createAgentModels` 变为异步

`createAgentModels(codexHome, magpie?: { baseUrl; apiKey }): Promise<MutableModels>`：先 `builtinModels(...)`；有 `magpie` 时 `fetchMagpieCatalog`（失败重试 5 次、间隔 3 s，仍失败抛 `magpie 模型目录不可达: …`，容器靠 restart 策略等 magpie 起来），`setProvider(createMagpieProvider(...))`。`main.ts` 仅当 `AGENT_MODEL_PROVIDER === "magpie"` 时传 magpie 参数（其他提供者不去碰 magpie）。目录只在启动拉一次；换模型需重启，与 codex 侧一致。

### 2.3 配置

- `PROVIDER_API_KEY_ENV.magpie = "CODEX_MAGPIE_KEY"`（`requireProviderApiKey("magpie")` 启动即校验）。`CODEX_MAGPIE_URL` / `CODEX_MAGPIE_KEY` 的注释改为"codex 与 pi 共用"。
- 默认值不变（`deepseek` / `deepseek-flash`），部署时 `.env` 改 `AGENT_MODEL_PROVIDER=magpie`、`AGENT_MODEL_ID=deepseek/deepseek-flash`。`DEEPSEEK_APIKEY` 保留给联网检索。
- 启动日志 `starting cs-agent` 已含 provider/model；再加一行 `pi models via magpie`（base_url、模型数）。

### 2.4 可观测

- `obs/metrics.ts`：DeepSeek 计价条件从 `d.provider === 'deepseek'` 扩成 `d.provider === 'deepseek' || (d.provider === 'magpie' && String(d.model).startsWith('deepseek/'))`。
- 设置页只读"出站方式"区块加一行 pi：`magpie（<base_url>）` 或 `直连 <provider>`。`DeepSeek 密钥` 灯保留（联网检索仍用它）。

### 2.5 不动的部分

`PiBackend`、`aging.ts`、pi-tools、`web.ts`、codex 侧全部文件、`entrypoint.sh`。

## 3. 测试

- `test/agent/magpie-models.test.ts`：用 §0 实测形状的 catalog 固定样本：deepseek-flash 继承内置 `compat.thinkingFormat === "deepseek"`、`thinkingLevelMap`、`cost.input === 0.3`，`contextWindow` 取 magpie 的 1000000，`api === "openai-completions"`；`codex/gpt-6.1-sol` → `openai-responses`、窗口 500000、`maxTokens 128000`、`thinkingLevelMap` 由 `reasoning_levels` 推导（`medium` 同名、`minimal` 为 null）、cost 0；未知 owner 走默认分支并 warn；`fetchMagpieCatalog` 用注入 fetch 验证 URL、Bearer、非 2xx 抛错；`createMagpieProvider` 返回的 provider `getModels()` 与输入一致、`baseUrl` 正确。
- `test/config.test.ts`：`requireProviderApiKey("magpie")` 缺 `CODEX_MAGPIE_KEY` 抛错，有则通过。
- metrics 测试补 magpie+deepseek/ 计价分支。
- 架构测试 `deps.test.ts` 需继续通过（新模块在 agent 层，只依赖 shared）。

## 4. 验收（主会话）

部署后：`.env` 切换 → 容器启动日志出现 `pi models via magpie`；临时把一个测试会话 override 到 pi（或等衰老任务跑）发一轮消息，magpie `usage.jsonl` 新增 `callerKeyName=cs-agent`、`req=deepseek/deepseek-flash` 的记录且回复正常（含思考档位 low 生效，`reasoning_content` 不报错）；设置页显示 pi 出站 magpie；容器内 `env | grep DEEPSEEK` 仍有 key（联网检索）。

## 5. 验收记录

（主会话追加）
