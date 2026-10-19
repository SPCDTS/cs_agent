# O3 上下文结构分析

统一入口为 `src/obs/context/index.ts` 的 `analyzeContext(adapters, backend, sessionId, options)`，HTTP 入口为 `GET /api/agents/:backend/sessions/:id/context?at=&phase=`。字段保持任务书的 `ContextAnalysis` 契约。`createSessionRoutes(adapters, sse)` 仍兼容，第三个可选参数接收只读目录、容量与上下文容量存储。

## 时点与来源

- 显式 `at` 使用 O1 回合 ID。`before` 包含用户输入及首次模型输出前已落盘的上下文；`after` 截止于该回合之后、下一回合开始之前。分析前先刷新回合索引；省略 `at` 始终返回最后回合之后，`at.phase` 为 `after`。
- Codex 从 O1 的文件定位快照读取，复用 `rolloutLines`，不读入整个 JSONL 字符串。反向选择回滚后存活的压缩检查点，再以 `replacement_history` 为基线重放后缀。中止不删除已接受的用户输入；缺失工具输出补重建的 `aborted`，删除孤儿配对输出，保留具名外部输出。reasoning 仅显示摘要，媒体与密文不进入预览或缓存。
- 无 replacement_history 的旧式压缩按官方 20000 近似 token 预算保留最近用户输入，并截去超预算正文中间；截断后的可见文本重新用 o200k 估算。已记录 input_modalities 时，在工具配对规范化之后应用图像/音频过滤；未记录时不推断模型能力，媒体占用标不可用。
- Codex 当前受管 AGENTS 与自定义提示标 `reconstructed`，并说明可能与当时不同；rollout 的基础指令标 `recorded`。生成 AGENTS 已含当前自定义段时拆分去重；已落盘的 AGENTS 注入归入指令并优先于当前版本。原始 system 消息按上游历史规则过滤，基础指令从元数据单独恢复。工具列表依据可见名字和设置负载估算，标 `estimated`。
- 官方 trace v1 优先读取 `manifest.json` → `trace.jsonl` → `payloads/*.json`，按线程和真实 Codex turn ID 关联。`before` 选首次请求，`after` 选最后请求并追加记录的响应和后续正文；增量请求沿 `previous_response_id` 回溯。未知格式、链不完整、超过载荷上限或请求后发生压缩/回滚时回退，不运行外部 reducer。
- 无可用 trace 实测时，从阶段边界之后最近的 `token_count.last_token_usage` 取值；之后没有记录则回退此前最后一次。跨回合或与窗口之间发生压缩/回滚时标 `stale`。cached 已包含在 input 中。after 的 input 仍是请求输入，不含该请求输出；差额仅写入 `unexplained`，允许为负。
- Pi 通过公开 `context(id, at)` 获取 `ContextView`。before 使用用户 entry，after 使用下一轮前最后一个 entry；省略 at 读取当前 view。系统与工具使用公开 `getCurrentSystemPrompt/getCurrentTools`，压缩分类使用 contributions 与 entries 对应关系，实测使用最后 assistant usage 的 input + cacheRead + cacheWrite。`estimateMessageTokens` 对照总计放在 notes。

## 估算、安全与性能

- `js-tiktoken@1.0.21` 与 `o200k_base` 是本地运行时依赖。每条计入角色与约 4 token 开销；单条正文最多 2 MiB，长文本每 8 KiB 分段。分段边界、脱敏替换及 provider 的实际模板会造成估算差异。词表不可用时明确报告 fallback；Pi 消息优先回退到 pi-ai。
- JSON 正文先使用 `redactSessionValue`，字符串使用 `redactText`，再生成不超过 240 字符的预览。固定契约字段 `key/tokens/tokenizer` 不作为凭据字段遮蔽。返回体再次脱敏所有字符串；不输出密文或媒体二进制，索引文件绝对路径不进入响应元数据。
- 正文引用由 O1 适配器签发，禁止把任意磁盘偏移伪装成 `ContentRef`。组合消息无法对应唯一正文块时省略引用，适配器拒绝签发时不再从其它路径补引用；replacement 中保留原 item ID 的消息可关联原已索引块。
- Codex baseline 使用分析时实际生效的 `session_meta.base_instructions` / `turn_context.base_instructions` 的 `ref`，通过 content 接口读取完整脱敏正文；索引版本 4 将其独立保存，不增加回合可见块，旧版索引自动重建，引用沿用虚拟 UTF-8 字节区间及内容变化时的 409 校验。
- rollout 缓存按文件路径、size、mtime 和文件身份区分，每个适配器最多 4 个投影快照，每份最多 4 MiB；超限不缓存。为旧式压缩保留用户文本各不超过 80 KiB 的首尾片段，其余正文只留预览与估算。读取前核对路径与身份，不跟随符号链接。trace 只扫描有限深度和目录数量，单个 JSON 载荷限制 8 MiB，路径必须位于 bundle 的 payloads 目录。
- HTTP 沿用 dashboard 鉴权、安全头与只读限制。无效参数 400，未知回合 404。JSON 超过 1 MiB 时先把预览缩到 80 字符，再截断消息表并加说明；分类计数与 token 总量保持完整窗口统计。

## 已知边界

- 分析是对模型窗口的观测投影；未知注入、加密正文和媒体 token 不可恢复。未记录完整工具 schema 时只能估算，不能把缺失信息显示成零。
- 历史首次请求没有明确请求开始记录时，以首个模型输出/usage 作为 rollout 边界；精确边界依赖 trace。Pi 下一次 prepare/provider 转换可能修改已提交的 context。
- 优先使用 rollout 记录的窗口容量，然后是调用方配置或现有容量存储；均不可用时保留现有 Codex 400000 / Pi 200000 的显示回退，并将 source 明确标为 default。
- 只读检查的真实 rollout 未包含压缩样本；相关 fixture 为按官方结构构造的匿名序列。trace fixture 来自官方 schema，尚未用本次真实模型回合产物复核。未知新 schema 会降级为 unavailable。
- 没有部署 Docker、修改 `.env` 或写入运行 `data/`；词表是否随镜像分发通过 Dockerfile 与生产依赖路径核对。

## O6 类别可用性补充

类别新增可选 `unavailable_items: number`，仅在存在不可用条目时返回其数量；旧字段不变。类别 provenance 取可见条目中占比最高的来源，同票依次优先 recorded、reconstructed、estimated。全部不可用或没有记录时仍为 unavailable。页面在部分不可用的类别主来源旁显示“部分不可用 N 条”；全部不可用时仍显示“不可用”。类别估算、估算总计及占窗口百分比只计可见部分，不把未知占用当作零；备注明确说明统计边界。

## O6 窗口口径补充

上下文占用记录新增可选 `effectiveWindowTokens`，从已完成 Codex 回合的 rollout `token_count.info.model_context_window` 读取最近正数值。启动回填和回合结束采样均保存此字段；扫描仍限制尾部 2 MiB，忽略尚未完成回合的尾部事件。`windowTokens` 保留模型目录名义值，不用固定 95% 公式推算有效值。

Codex 占用条的首屏、SSE 更新、占比排序和无障碍文本均优先使用有效窗口；提示同时显示“名义 500,000 / 有效 475,000”。无有效值或旧记录没有该字段时继续使用名义窗口，Pi 口径不变。新线程重置或名义容量变更后丢弃旧有效值，待 rollout 重新采样。

分析接口的 `window.tokens/source` 保持原来源优先级；若 `contextUsage` 有同域 Codex 名义窗口，额外返回 `window.nominalTokens` 并在页面头部显示。历史分析仍用当时 rollout 的窗口；名义值取当前记录，两者可能属于不同模型配置，不据此反算预留比例。
