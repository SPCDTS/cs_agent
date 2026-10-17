# 设计 v2：聊天记录衰老与检索、意图层会话感知、联网检索、"先查再画"

> 状态：v2，按用户反馈简化。未实现。
> 相比 v1 的变化：取消 codex 线程分域与轮换；历史记录改为分层衰老而非硬删除；资料查询由意图识别 agent 用 DeepSeek Search/Fetch API 完成，不再借 codex 一次性会话。

## 0. 目标与问题

| 现状 | 问题 |
|---|---|
| codex 每轮只拿到一行来源标注 + 正文 | 看不到任何 QQ 历史，"刚才那条"、"上面说的"无法理解 |
| 意图模型每条消息一个无状态会话 | "把刚才那张图改成蓝色"、"继续"无法路由 |
| `AGENTS.md` 只有安全规则 | 回复格式靠意图层兜底 |
| `web_search` 未配置 | codex 时效性问题答不准 |
| 意图层"恰好一个业务工具" | 生图涉及现实实体/时事时无法先查资料 |

## 1. 原则

1. **拉取优于推送**：历史不随每轮注入；需要时通过工具按需拉取，返回紧凑文本、有硬上限。
2. **衰老优于删除**：原始消息 → 日摘要 → 周摘要，越久远越粗，像上下文压缩一样分层。
3. **单一 codex 线程，依赖其自带压缩**：不分域、不轮换，只留一个极宽松的安全阀。
4. **访问过滤**：存储不分域，但群内查询只见本群；owner 私聊可查全部。
5. **研究在意图层**：DeepSeek 用自家 Search/Fetch API 查资料并组装生图提示词；codex 线程保持干净。

## 2. 聊天记录：本地消息库 + 分层衰老

### 2.1 存储（QQBridge 新增职责）
`/data/qq-messages.sqlite`，`node:sqlite`（容器内 SQLite 3.53，FTS5 可用）：

| 表 | 内容 |
|---|---|
| `messages` | `scope`(group:<id> / private:<qq>)、`message_id`、`time`、`user_id`、`nickname`、`is_self`、`text`、`reply_to_id`。允许范围内**全部**消息入库（含不触发的群消息、机器人自己的回复）。媒体只存 `[image]` 等占位。 |
| `messages_fts` | FTS5 虚表，`tokenize='trigram'`，支持中文子串检索 |
| `summaries` | `scope`、`level`(day / week)、`period_start`、`period_end`、`text`(≤400 字)、`msg_count`、`created_at` |
| `summaries_fts` | 同上 |

### 2.2 衰老调度（agent 侧每日任务，容器内 03:00）
1. **日摘要**：对每个 scope 前一天的消息（≥5 条才做），用 `deepseek-flash` 生成 ≤400 字摘要：参与者、讨论主题与结论、待办/承诺、机器人做过的事。写入 `summaries(level=day)`。
2. **周摘要**：日摘要满 7 天后合并成一条 ≤400 字周摘要，删除对应日摘要。
3. **原始消息**：超过 `HISTORY_RAW_DAYS`（默认 30）删除。
4. **周摘要**：超过 `HISTORY_SUMMARY_DAYS`（默认 180）删除。
5. 撤回事件：删除原始行；已生成的摘要不回溯修改。
摘要生成是唯一的模型开销，每天每 scope 一次，忽略不计。

### 2.3 检索服务 `qq_context`（容器内 stdio MCP，Node）
注册进受管 `config.toml`：
```toml
[mcp_servers.qq_context]
command = "node"
args = ["/app/dist/mcp/qq-context.js"]
startup_timeout_sec = 10
tool_timeout_sec = 15
```
**访问范围按次注入**：每次 `codex exec` 追加 `-c mcp_servers.qq_context.env.QQ_ACCESS="group:200000001"` 或 `"all"`（owner 私聊）。MCP 进程只按该范围过滤，参数里不接受范围。

| 工具 | 参数 | 返回 | 上限 |
|---|---|---|---|
| `qq_recent` | `limit≤30`, `before_message_id?` | `HH:MM 昵称: 文本`，自己发的标 `[我]` | 单条 ≤120 字，总量 ≤2500 字 |
| `qq_search` | `query`, `days≤180`, `limit≤20` | 原始消息与摘要混排，按时间倒序；摘要行标 `[日摘要 10-15]` / `[周摘要 10-06~10-12]` | 同上 |
| `qq_message` | `message_id` | 完整正文 + 引用链（≤3 层） | ≤1500 字 |

同一个库也供意图层读取（§4），不经 MCP，直接进程内访问。

### 2.4 统一上下文（意图层与 codex 共用同一套）
意图层与 codex 的"会话感知"来自**同一个存储、同一个格式化模块**，不再单独维护 interactions 表：
- 机器人自己的回复作为 `is_self=1` 的消息行入库，并附带元数据列 `action`（generate_image / research+generate_image / ask_codex / fallback）、`detail`（生图最终英文提示词 / codex 推理强度）、`ticket`、`status`（处理中 / 已回复 / 失败）。"处理中"行在收到消息时就写入，回复后更新为已回复并补上正文摘要。
- `src/context/store.ts`：唯一的读写入口（入库、撤回、衰老、`recent()`、`search()`、`message()`、访问过滤）。
- `src/context/format.ts`：唯一的紧凑格式化器，输出 `HH:MM 昵称: 文本`，机器人行渲染为 `HH:MM [我] → 生图 prompt="..." → 已发送 1 张图` 或 `[我] → codex(high) → "摘要"`。
- 消费方：
  - 意图层：派发器在每条消息前调用 `recent(scope, window=120min, limit=5)` 注入上下文块；工具 `recent_context` / `search_history` 直接进程内调用同一模块。
  - codex：`qq_context` MCP 服务是同一模块的 stdio 外壳，工具 `qq_recent` / `qq_search` / `qq_message` 一一对应，访问范围由 `QQ_ACCESS` 注入。
- 效果：两层看到的历史内容、裁剪规则、字数上限完全一致；追问"把刚才那张图改成蓝色"时，意图层与 codex 看到的都是同一行 `[我] → 生图 prompt="..."`。

## 3. codex 执行层

### 3.1 两条线程：owner 与 shared（2026-10-18 用户决定）
- 评审指出单一线程会让 owner 私聊内容经 codex 记忆泄露到群聊。改为两条线程：`owner`（owner 私聊）与 `shared`（所有群与其他用户），映射存 `codex-threads.json`，旧 `codex-session.json` 迁移为 `owner`。每条线程一把互斥锁，两条可并行。
- 历史检索仍不按线程分域，访问过滤见 §2.3。
- 依赖 codex 自带的自动上下文压缩。安全阀：rollout 文件 > `CODEX_ROLLOUT_MAX_MB`（默认 50）或线程 > `CODEX_THREAD_MAX_DAYS`（默认 90）时新建线程（无交接摘要，历史靠 §2 的检索找回）。
- 全局一把互斥锁（不变）。

### 3.2 每轮注入（最小化）
```
[来源] 群 200000001 · 昵称(QQ号) · 2026-10-17 22:41
[引用] 昵称: 被引用消息正文（≤200 字，仅当带 reply 段）
<正文>
```
规则一律放 `AGENTS.md`，不随轮注入。

### 3.3 `AGENTS.md`（热编辑，`/workspace`）
回复规则：
- 回答原样显示在 QQ：纯文本，不用 Markdown、代码围栏、表格、标题符号。
- 中文；默认 ≤300 字，用户明确要长文再放开（中继层 4000 字截断）。
- 不复述问题，不解释用了什么工具，不输出"作为 AI"套话。
- 链接最多 1 条；不确定的事实明说"未核实"，不编造。
- 群聊面向群内读者，私聊面向本人。

历史工具纪律：
- 仅当消息指代此前内容（"刚才"、"上面"、"那个"、无先行词代词、明显追问）或用户要求回顾时调用 `qq_recent`。
- 优先 `qq_search` 带具体关键词；一次请求最多调用历史工具 2 次。
- 不复述检索到的原文，只给结论。

安全规则维持现状。

### 3.4 Web 搜索
受管 `config.toml`：
```toml
web_search = "live"            # CODEX_WEB_SEARCH=live|cached|disabled，默认 live
[tools.web_search]
context_size = "low"           # CODEX_WEB_SEARCH_CONTEXT，默认 low，限制搜索结果注入量
```

## 4. 分流与执行（v3，2026-10-18 用户决定：规则分流器 + 可切换后端的执行 agent）

> 取代 v2 的"意图识别 agent / 路由器"。分流不用模型：消息以 `奶龙:` 开头 → 前缀之后全部作为提示词直接生图；否则整条消息交给**执行 agent**。执行 agent 有两个可互相切换的后端：**pi-durable**（进程内 durable 会话 + 工具）与 **codex**（容器内 CLI 固定线程）。

### 4.1 规则分流器（无模型）
- 取 normalize 后的 `text`（群聊的真实 at 段已由 bridge 剥离）去首尾空白；前缀匹配 `IMAGE_PREFIXES`（默认 `奶龙:,奶龙：`，逗号分隔，大小写与全/半角按配置原样匹配）。
- 命中：`prompt = 前缀之后的全部文本`（保留原文，不翻译不改写）；为空 → 回复固定用法提示"奶龙: 后面写要画的内容"。
- 未命中：整条原文交给执行 agent。
- 分流结果与原因写入票据文档（`route: image|agent`，`prefix`），供观测。

### 4.2 生图路径（无模型）
pi-durable 任务两阶段：`generate`（现有 generate-image 实现，走 comfy-mcp / http）→ `reply`（固定模板：成功"图片生成好了"+ 图；失败按类别：服务不可用 / 超时 / 内容被拒 / 其他）。检查点保证崩溃后不重复生图、不重复发送。统一上下文 `completeReply(action=generate_image, detail=prompt)`。

### 4.3 执行 agent 与后端抽象
```ts
interface AgentBackend {
  name: "codex" | "pi";
  handle(req: { ticket; scope; access; threadKey: "owner"|"shared"; source; text; quote? },
         ctx: { signal; onEvent(e) }): Promise<{ text: string }>;
}
```
- 选择：`AGENT_BACKEND=codex|pi`（全局默认 `codex`，保持现状），可选 `AGENT_BACKEND_OVERRIDES=group:200000001=pi,private:10000001=codex` 按 scope 覆盖。切换只影响后续消息，两后端的记忆各自独立。
- **线程键**沿用 owner / shared 两分（§3.1），两后端都按此隔离记忆；同一线程键串行，不同并行。
- **图片附带（两后端统一）**：后端在回合中若调用了生图（pi 的进程内工具 / codex 的 `image_gen` MCP），图片写入 `/data/images/<ticket>/`；适配层在回合结束后收集该目录内本回合产生的文件（≤4 张）随文本一并发出。后端不需要也不能指定回复目标。
- **回复后处理（两后端统一）**：代码清洗（去 Markdown 代码围栏/标题/表格符号，不出现 `@`，UTF-16 ≤4000 截断）。codex 后端额外保留 `CODEX_REPLY_MODE=relay|direct`（默认 `relay`：用意图模型做一次 ≤5 行提示的格式整理，失败回退清洗；`direct`：仅清洗）。pi 后端由其系统提示直接产出合规文本，仅清洗。

### 4.4 codex 后端（现有能力的适配）
- 现有 ask-codex：owner/shared 线程、`CODEX_HOME` 受管配置、`qq_context`（`QQ_ACCESS` 按次注入）、浏览器 MCP、`web_search = "live"`、沙箱与 deny_read。
- 推理强度：不再由模型选择，取 `CODEX_REASONING_EFFORT`（默认 high）；允许消息内显式指令如 `#low` / `#xhigh` 前缀？——**不做**，保持简单。
- 新增 **`image_gen` MCP**（容器内 stdio，复用 generate-image 实现）：工具 `generate_image(prompt)`，输出目录由每次 `-c mcp_servers.image_gen.env.IMAGE_TICKET_DIR=/data/images/<ticket>` 注入，返回生成文件名；工具注解非只读，审批模式同 `approve`。于是 codex 可以先 web_search 再生图（"先查再画"由执行 agent 自行决定，不再有专门研究器）。
- `AGENTS.md`（全局受管）补一条：需要出图时调用 image_gen，图片会随回复自动发给用户，回复文本只需一句说明。

### 4.5 pi-durable 后端（新）
- **每个会话域一条长期 durable conversation**（2026-10-18 评审后决定：owner 私聊一条；每个群一条；每个其他私聊用户一条；键 = `owner` | `<scope>`），id 持久化在 `/data/pi-threads.json`。与 codex 的 owner/shared 两分不同：pi 会话成本低，按域隔离可彻底避免非 owner 私聊与群聊共享记忆与压缩摘要。自动 compaction 开启（`reserveTokens` / `backgroundTokens` 取 pi-durable 默认或配置），记忆靠 compaction 摘要，不做轮换。
- 模型：`AGENT_MODEL_PROVIDER`/`AGENT_MODEL_ID`（现为 deepseek / deepseek-flash）、`AGENT_THINKING_LEVEL`。
- 工具（进程内，复用同一实现）：`web_search(query, count≤8)`、`fetch_page(url)`（§4.6）、`qq_recent` / `qq_search` / `qq_message`（统一上下文存储，**访问范围绑定到当前请求**：由适配层在 submit 时把 access 写入会话文档，工具执行时读取；shared 线程内不同 scope 的请求串行，因此不会串用）、`generate_image(prompt)`（写 `/data/images/<ticket>/`）。不接浏览器。
- 系统提示：`/data/prompts/agent.md` 热加载（与 codex 的 AGENTS.md 规则对齐：纯文本中文简短、不可信内容声明、历史工具纪律、需要事实先搜索、需要出图调用 generate_image 并一句话说明）。内置默认值在代码中。
- 每轮输入格式与 codex 相同：`[来源] … / [引用] … / 正文`。
- 工具调用上限（代码守卫）：每回合 `web_search ≤4`、`fetch_page ≤4`、`generate_image ≤2`、历史工具 ≤4；超限工具返回错误文本。回合超时 `PI_TURN_TIMEOUT_SEC`（300）。

### 4.6 联网检索工具（DeepSeek Search/Fetch API，pi 后端使用）
已核实：`POST https://api.deepseek.com/v1/tools/search`（`query` ≤128 字、`count` ≤50、`need_content`、支持 `site:` `lang:` `after:` 操作符）与 `POST /v1/tools/fetch`（`url` → Markdown 正文），同一 API key，5 QPS，$0.75/千次，2026-11-01 前免费。
| 工具 | 参数 | 返回 | 上限 |
|---|---|---|---|
| `web_search` | `query`, `count≤8` | 每条 `标题 / 日期 / 摘要(summary) / url`，按 rerank_score 排序 | 总量 ≤2500 字 |
| `fetch_page` | `url` | 页面正文 | ≤4000 字，超出截断 |
429 时退避重试一次；其他 4xx 不重试。codex 后端用 codex 自带的 web_search，不走这组。

### 4.7 会话感知与顺序
- 两后端都有自己的记忆（codex 线程 / pi 会话 compaction），再加 `qq_context` 工具按需拉取历史；不再向任何模型注入"近期交互"上下文块。
- 派发器按 scope FIFO 串行，不同 scope 并行（受 `AGENT_CONCURRENCY`）：保证同一会话里回复顺序与消息顺序一致。
- 生图路径不经过任何 agent，追问改图（"把刚才那张改成蓝色"）会进入执行 agent，由它用 qq_context 看到上一条 `[我] → 生图 prompt="…"` 后调用生图工具完成。

### 4.8 容器内浏览器（codex 后端）（替代 egolite）
已核实：ego (lite) 目前仅有 macOS 桌面版，Windows 为未开放的 closed beta，Linux 在路线图；没有 headless / 独立 CLI / Docker 模式，agent 通过 `ego-browser` 技能驱动桌面应用内的页面 JS 工具，协议未公开。它无法在 Linux 容器内运行，本机也未发现安装。

本期方案：
- **阅读型需求**（绝大多数）：意图层用 DeepSeek `fetch_page`（页面 → Markdown），codex 用 `web_search = "live"`。不需要浏览器。
- **交互型需求**（JS 渲染页、点击、登录态）：给 codex 配 `@playwright/mcp`（headless Chromium，容器内安装，镜像约增 400 MB），注册为 `[mcp_servers.browser]`，`--headless --isolated`，无宿主机登录态。意图层不接浏览器。
- egolite 推出 Linux/headless 版本后，可用同一个 `[mcp_servers.browser]` 槽位替换，AGENTS.md 中的浏览器使用纪律不变。
- 开关：`CODEX_BROWSER=playwright|none`，用户已确认本期默认 `playwright`。
- 可写目录（用户 2026-10-18 决定）：`/workspace`、`/data/prompts`、`/data/workflows`。其中 `/data/prompts` 可写意味着任何能触发 codex 的发送者理论上可经 codex 修改热加载的系统提示；用户知悉并接受，仅以 AGENTS.md 软规则限制为"owner 私聊明确要求时才改"。



### 4.9 生图工具 v2：发挥 Qwen Image 2.1 Turbo 的能力（2026-10-18 用户需求）

已核实（宿主机 ComfyUI、RTX 4070 Ti SUPER 16 GiB、INT8 Turbo + W4A8 文本编码器）：
- Turbo 固定 8 步、CFG 1、euler/simple（调度写在权重里，改步数无效）。
- 原生 2K（2048×2048）输出；默认 1MP；尺寸取 32 的倍数；预设最大到 2752×1536（16:9）及对应竖版。
- 生成与编辑是同一模型：`TextEncodeQwenImage21(prompt, negative_prompt, resolution, images[], vae)` 接受多张参考图（看图编辑、多图参考），输出正/负 conditioning 与 LATENT。
- `EmptyQwenImageLayeredLatentImage(width, height, layers)` 支持透明（RGBA/分层）输出；`QwenImage21Cache` 为 KV 缓存提速；官方模板还带 Qwen 3.5 提示词增强器（需额外模型，本期不做）。
- 文本渲染是 Qwen Image 的强项（中英文海报、UI、招牌）。

**工具接口（统一供三处使用：前缀路径、pi 后端进程内工具、codex 的 image_gen MCP）**
```ts
generate_image({
  prompt: string,                 // 原文，不翻译
  negative_prompt?: string,
  aspect?: "1:1"|"16:9"|"9:16"|"4:3"|"3:4"|"3:2"|"2:3",   // 默认 1:1
  size?: "1mp"|"2mp"|"2k",        // 默认 1mp；2k 仅 1:1 为 2048² ，其他比例按预设表
  count?: 1|2|3|4,                // batch_size，默认 1
  seed?: number,                  // 默认随机
  reference_images?: string[],    // ≤3，仅允许本票据的 incoming 目录内文件（看图编辑/参考）
  transparent?: boolean           // 分层潜变量，输出 PNG 带 alpha
})
```
- 工作流不再用静态 JSON 文件，改为代码按参数**生成 API 图**：UNETLoader → [QwenImage21Cache] → TextEncodeQwenImage21 → EmptyLatentImage / EmptyQwenImageLayeredLatentImage → KSampler(8, 1.0, euler, simple) → VAEDecode → SaveImage。编辑图的接线（参考图经 LoadImage 送入 `images`，`resolution` 取目标尺寸的边长）须以宿主机 `comfyui_workflow_templates` 包内的官方 Qwen Image 2.1 编辑模板为准核对，不凭猜测。
- 尺寸预设表（32 的倍数）：1mp：1:1 1024², 16:9 1344×768, 9:16 768×1344, 4:3 1152×864, 3:4 864×1152, 3:2 1216×832, 2:3 832×1216；2mp：按 1.414 倍取整到 32；2k：1:1 2048², 16:9 2752×1536, 9:16 1536×2752, 3:2 2528×1696, 2:3 1696×2528, 4:3 2368×1792, 3:4 1792×2368。超时按像素数与 count 线性放大（基准 1MP×1 = 60 s，上限 `COMFY_TIMEOUT_SEC`）。
- 旧 `COMFY_WORKFLOW_FILE` 保留为"自定义工作流覆盖"：设置时仍走文件（只替换提示词与 seed），不设置时走生成器。`/data/workflows/` 内可放用户自定义图。

**参考图来源（QQ 看图编辑）**
- QQBridge 对**触发**的消息下载图片段（OneBot `image` 段的 `url`/`file`，≤3 张、每张 ≤10 MiB、魔数校验）到 `/data/incoming/<ticket>/`，`InboundMessage.images: string[]`；未触发的消息不下载（历史库仍只存 `[image]` 占位）。保留 7 天后清理。
- 前缀路径：`奶龙:` 消息自带图片 → 自动作为 `reference_images`（编辑模式）。
- 后端：pi 工具参数 `reference_images` 只接受本票据 incoming 目录内的路径；codex 的 image_gen MCP 以 `-c mcp_servers.image_gen.env.IMAGE_REFS="<逗号分隔路径>"` 注入可用参考图清单，工具参数只能从中选择。

**前缀路径的内联选项**（`奶龙:` 之后、提示词之前，可多个，顺序任意，未识别的词算提示词）
`16:9` `9:16` `4:3` `3:4` `3:2` `2:3` `1:1` / `横`(16:9) `竖`(9:16) `方`(1:1) / `2k` `2mp` / `x2` `x3` `x4` / `透明`。例：`奶龙: 横 2k 一只在雪地里的橘猫`。

**提示词指引（写入 AGENTS.md 与 agent.md）**
- 直接用用户语言描述；要在图中出现文字时，把文字放在引号里并说明位置与字体风格（Qwen 对中英文文字渲染准确）。
- 编辑时描述"改什么、保留什么"；多图参考时说明每张图的用途。
- 不要加 "masterpiece, 8k" 之类的 SD 式咒语。

**不做**：提示词增强器、ControlNet、LoRA 管理、超过 2K 的分辨率。

## 5. 配置项（新增）

```
HISTORY_RAW_DAYS=30
HISTORY_SUMMARY_DAYS=180
HISTORY_SUMMARY_HOUR=3
QQ_CONTEXT_MAX_CHARS=2500
CODEX_WEB_SEARCH=live
CODEX_WEB_SEARCH_CONTEXT=low
CODEX_ROLLOUT_MAX_MB=50
CODEX_THREAD_MAX_DAYS=90
INTENT_CONTEXT_ITEMS=5
INTENT_CONTEXT_WINDOW_MIN=120
INTENT_CONTEXT_MAX_CHARS=1500
WEB_SEARCH_MAX_PER_MESSAGE=2
FETCH_MAX_PER_MESSAGE=2
CODEX_BROWSER=playwright
CODEX_REPLY_MODE=relay
CODEX_REPLY_SANITIZE=true
```

## 6. 边界与隐私

- 群成员可让 codex 检索**本群** 30 天原始消息与 180 天摘要，与其本来能翻群记录一致；owner 私聊可查全部；私聊内容对群不可见。
- 摘要由模型生成，可能有偏差，只影响"记忆"，不影响权限与路由。
- `./data` 含聊天记录与摘要，按聊天记录保管。

## 8. 观测系统（用户新增需求）

目标：直观看到整体运行状态，出问题时能顺着一条消息的全链路排查。本地使用，不做多用户权限。

### 8.1 数据
- **事件表** `/data/observability.sqlite` → `events(ticket, scope, ts, stage, status, duration_ms, detail_json)`。`ticket` 是全链路关联 id。阶段：`received → admitted → dispatched → model_turn → tool:<name> → reply_sent | failed | fallback`。工具事件记录输入摘要（提示词、查询词、推理强度）、输出摘要、耗时、错误类别；模型事件记录 provider/model、输入输出 tokens。敏感值（token、key）永不入库。
- **统一埋点 API** `src/obs/trace.ts`：`trace.event(ticket, stage, {...})`，派发器与每个工具调用。日志行同时带 `ticket` 字段，便于 `docker compose logs | grep`。
- **指标**（内存聚合 + 周期落盘到 `metrics` 表）：按工具/模型的调用数、成功率、p50/p95 耗时；队列深度与各 scope 排队数；NapCat WS 状态与断线次数；codex 线程 rollout 大小与轮数；DeepSeek 用量与估算费用；ComfyUI 任务耗时；衰老任务上次运行结果。
- 保留 `OBS_RETENTION_DAYS`（默认 30）。

### 8.2 面板（容器内 HTTP，`127.0.0.1:8787` 发布到宿主机 localhost）
服务端渲染 HTML + 少量原生 JS + SSE，不引入前端框架，不增大镜像。页面：
| 页面 | 内容 |
|---|---|
| `/` 总览 | 健康状态（WS、comfy、codex、DeepSeek key、衰老任务）、最近 1h/24h 吞吐与错误率、队列、当前处理中的票据 |
| `/tickets` | 票据列表（时间、scope、发送者、意图动作、状态、总耗时），筛选失败/超时 |
| `/tickets/<id>` | 单条全链路时间线：原文 → 注入的上下文块 → 模型每轮（tokens）→ 工具调用（提示词/查询/强度、耗时、结果摘要、生成图缩略图）→ 回复正文 → 票据状态流转 |
| `/logs` | SSE 实时日志尾随，按 ticket / level 过滤 |
| `/context` | 按 scope 浏览消息库与摘要，试跑 `recent` / `search` 看 codex 会看到什么 |
| `/codex` | 线程 id、轮数、rollout 大小、最近交接/新建记录、AGENTS.md 当前内容 |
| `/config` | 生效配置（脱敏）、系统提示当前内容与 mtime |
`docker-compose.yml` 增加 `ports: ["127.0.0.1:8787:8787"]`；可选 `OBS_TOKEN` 作为简单访问口令（默认空，仅本机）。

### 8.3 告警（可选）
`ALERT_OWNER=true` 时，WS 断线超 5 分钟、codex/DeepSeek 鉴权失败、连续 3 条票据失败，向 owner 私聊发一条告警（限频 1 次/30 分钟，走 `send()` 而非票据）。默认关闭。

## 7. 实施拆分（各自测试、单独重建部署）

1. **消息库 + 衰老任务 + `qq_context` MCP + AGENTS.md + codex web_search**。测试：假 OneBot 入库/撤回/清理、摘要任务（faux 模型）、FTS 中文检索、MCP 上限与访问过滤、`QQ_ACCESS` 注入。
2. **规则分流 + 生图路径 + 后端抽象 + codex 适配**（§4.1–4.4）：`IMAGE_PREFIXES` 分流、两阶段生图任务、`AgentBackend` 接口与 `AGENT_BACKEND` 切换、codex 适配（固定 effort、`image_gen` MCP、图片收集、relay/direct 后处理）、按 scope FIFO。意图模型的 `route` 会话与系统提示退场（`system.md` 不再使用，保留文件但记录弃用）。测试：前缀匹配（半/全角、空提示）、生图崩溃恢复不重复、codex 适配经 fake codex、image_gen MCP 经 stdio、图片收集上限、后处理清洗。
3. **pi-durable 后端**（§4.5、4.6）
3b. **生图工具 v2**（§4.9）：参数化工作流生成器、尺寸预设、透明输出、参考图编辑（bridge 下载触发消息的图片）、前缀内联选项、三处接入（前缀路径 / pi 工具 / image_gen MCP）。测试：工作流生成器快照、预设表、内联选项解析、参考图路径限制、bridge 图片下载与清理；真实 ComfyUI 冒烟（1MP 文生图、16:9、透明、单图编辑）。
（原 3）：长期 durable 会话（owner/shared）与 compaction、进程内工具（web_search / fetch_page / qq_* / generate_image）、访问范围绑定、`agent.md` 热加载提示、调用上限与超时、`AGENT_BACKEND=pi` 切换与 overrides。测试：faux 模型工具调用链、访问范围隔离、上限守卫、429 退避、切换后端互不影响。
4. **观测系统**（§8）：事件表与埋点、指标、面板、可选告警。测试：埋点覆盖每个阶段、面板页面渲染、SSE、脱敏。

决策（2026-10-17 用户确认）：设计 v2 通过；`CODEX_BROWSER=playwright` 本期开启。

每组完成后由 Codex 做一轮独立评审。

## 9. 验收记录

### 第 1 组（2026-10-18，主会话验收通过）
- 独立复跑：typecheck、178 测试、build、镜像构建通过；`docker compose up -d --build` 部署，容器 healthy。
- 代码审读：访问范围只来自票据/环境变量，`all` 仅 owner 私聊，所有读取带访问子句；entrypoint 对路径、枚举、可写目录白名单校验并规范化。
- Codex 对抗评审 8 条：7 条修复（含 2 条阻断：codex 命令可读 `/data` 凭据与库 → `/etc/codex/requirements.toml` 的 `deny_read`；单线程跨会话泄露 → owner/shared 双线程），1 条接受（浏览器黑名单非安全边界，用户已允许命令联网）。
- 主会话发现并修复：规则文件可被 codex 改写 → 移到只读的 `$CODEX_HOME/AGENTS.md`；头部昵称/引用可伪造行 → 清洗；浏览器 `browser_run_code_unsafe` 可在 MCP 进程内读凭据 → `enabled_tools` 白名单；非交互 exec 下 MCP 调用需审批 → `default_tools_approval_mode = "approve"`（`auto` 实测无效）。
- 实测（新镜像）：沙箱内凭据/库/图片不可读，仅三个目录可写，命令可访问宿主机 ComfyUI，环境无密钥；`scripts/verify-browser-mcp.mjs` 12/12 通过；真实 codex 回合经生成配置成功调用 `qq_recent`。
- 已知残余风险见 DEPLOY.md：`/data/prompts` 可写仅靠软规则；浏览器黑名单不拦重定向；`auto` 审批模式在工具加 readOnly 注解后或可用但未验证。

### 第 2 组 v3（2026-10-18，主会话验收通过）
- 独立复跑：typecheck、262 测试、build、镜像构建通过；`docker compose up -d --build` 部署，容器 healthy，受管 config.toml 含 qq_context / image_gen / browser 三个 MCP。
- 代码审读：规则分流器（route_text 由 bridge 按真实段计算、最长前缀匹配）、后端选择（严格校验 overrides）、图片收集（跳过软链接、魔数、≤4）、任务阶段守卫与检查点、提交意图与文件名前缀对账。
- 两轮对抗评审（gpt-6-sol 11 条、gpt-6-astra 6 条）全部修复：codex 回合按票据输出文件幂等；生图 submit/collect 拆分 + 提交意图 + 文件名前缀对账（历史 → 队列 → 探测输出）；scope 队首到终态语义、达到上限先中止任务；恢复按 bridge seq 排序并分页；取消信号贯穿回复准备；排队不消耗重试次数；票据工作目录终态清理并对 codex 沙箱禁读。
- 实测：真实 codex 回合经 image_gen MCP 在宿主机 ComfyUI 生成 PNG（约 1.8 MB，写入 `call-1/`）。
- 接受的残余：ComfyUI 接受提交与返回之间崩溃仍可能重提一次（comfy-mcp 不支持客户端指定 id）；`failed` 派发条目不清理（第四组保留策略处理）。

### 生图工具 v2（2026-10-18，主会话验收通过）
- 独立复跑：typecheck、364 测试、build、镜像构建通过；部署后容器 healthy。
- 实现与设计 §4.9 的偏差（已确认）：透明输出不用 `EmptyQwenImageLayeredLatentImage`（属另一套 layered 模型，latent 维度不匹配），改按官方 background_removal 模板的解码链输出 RGBA，本机依赖齐全。
- 真实 ComfyUI 结果（实现方）：1MP 15 s、16:9 40 s、2K 388 s、透明 17 s（alpha 有效）、单图编辑 14 s。
- gpt-6-astra 评审 9 条全部修复：参考图下载 SSRF 防护（内部主机名拦截、全部 DNS 地址校验、固定 IP 连接、≤3 跳逐跳重验）；先接纳落盘再下载、按会话有界并发、重启续传；图片头尺寸/动图校验；上传副本用完覆盖为 1×1 透明 PNG；2K 预算按实测调整、超时后延期收取；目录 confinement 顺序；别名查找原型键；stdio 测试统一构建。
- 运维变更：`.env` 清空 `COMFY_WORKFLOW_FILE` 以启用参数化工作流，`COMFY_TIMEOUT_SEC=600`。
- 接受的残余：ComfyUI history/queue 仍残留上传文件名；七天清理只覆盖本机 incoming。
