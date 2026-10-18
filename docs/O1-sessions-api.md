# O1 会话观测数据接口

O1 提供 Codex/Pi 统一会话模型、后台索引、回合正文、按需读取与 SSE。O2 可以直接使用这些接口；O3 可以继续使用 `PiSessionSource.context(id, at)` 与 Codex rollout 事实源。本组没有实现新 UI、上下文重建或记忆分析，旧 `/codex`、`/pi`、`/context` 页面继续工作。

## 接口契约

全部接口只接受 GET，沿用面板 cookie 鉴权、Host 校验、CSP 和 `Referrer-Policy: same-origin`。URL 中的口令只用于 303 换取 cookie，不作为响应内容返回。未登录返回现有的 401 登录页；已登录的新 API 返回 JSON。

| 路由 | 返回内容 |
| --- | --- |
| `/api/agents` | 两个后端的活动/归档会话数、最近更新时间与 `indexing: { indexing, files, done }` |
| `/api/agents/:backend/sessions` | 会话数组；`status=active\|archived`、`scope`、`since`、`page` 可选；每页 50 条，page 从 0 开始 |
| `/api/agents/:backend/sessions/:id` | `{ session, turns }` |
| `/api/agents/:backend/sessions/:id/turns/:turn` | `{ turn, blocks }` |
| `/api/agents/:backend/sessions/:id/content?offset=&length=` | `{ text, truncated }` |
| `/agents/stream?backend=&session=` | 活动会话的 SSE，`event: block`，数据为 `{ session, turn, block }` |

`since` 接受非负毫秒时间戳或 ISO 日期/时间，按会话更新时间筛选。会话与回合 ID 来自索引返回值，客户端应逐段 URL 编码。错误的筛选、编码或正文范围返回 400；未知资源返回 404；归档 SSE 返回 409。索引尚未发现的会话也会返回 404，应结合后台进度稍后重试。

正文不超过 8 KiB 时内联 `text`；超过时返回 `preview` 与 `ref`。`ContentRef.offset/length/bytes` 表示适配器分配的、脱敏正文的虚拟 UTF-8 字节区间，**不是可以任意读取文件的磁盘偏移**。磁盘中的行和回合字节偏移另存于 `session_index`。请求区间必须完全落在一个当前已索引正文块中，不能跨块；以服务端刚返回的 ref 为准，重建索引后旧 ref 可能失效。

所有正文先整体脱敏再截取，子范围不会绕过秘密注册表。UTF-8 切片不拆开汉字。普通 JSON 超过编码后 1 MiB 时返回 413；content 响应按同一上限裁剪并设置 `truncated: true`。客户端可用较小的 length 分段读取；有转义字符时，JSON 体积可能显著大于正文体积。

核心五种类型保持设计 §2 的形状，另用 `ObservedTurn` 交叉类型补充 `delivery: { status, scope?, duration_ms? }`。模型回合 `status` 与 QQ 送达状态分别保留。票据仅通过相同后端、派发时的真实会话 ID 与相邻回合时间窗口匹配；不以 owner/shared 键或正文猜测归属，歧义时不附加票据。ObsStore 不提供正文。

## 索引与实时更新

Codex 在 `observability.sqlite.session_index` 保存文件大小、mtime、文件身份、边界指纹、扫描位置、回合/行偏移、工具配对状态与用量。未变化的文件不重新解析；可信追加从上次完整位置继续；截断、文件替换和检测到的改写重新索引。单行最多解析 4 MiB，超大行只生成“行过大”事件，后续正常行继续处理。正文展开时按行回源，不整体读取 rollout。

追加识别用文件身份与旧文件首尾指纹，避免每次轮询重读整个大文件。“原 inode 不变、首尾指纹区间不变、只改写中间并同时增长”的特殊操作不能立即由这一步识别；展开受影响正文时还会校验行摘要，返回 409、标记为脏，并在下一次后台扫描全量重建。在展开前，相关目录摘要可能仍为旧值。正常 Codex 追加、截断及轮换均有回归测试。

Pi 通过公开 `scanConversations`、`entries`、`context`、`watchEvents` 接口读取。线程和归档的公开文档给出 scope/状态；不查询 pi 私有 SQLite 表。条目游标增量处理，实时总线可用时订阅，同时保留每 2 秒轮询兜底。Pi 索引保存在进程内，重启后由公开 entries 重建。

SSE 推送新增块，复用原有背压队列、连接上限和心跳。会话详情应先通过 JSON 获取快照；连接断开后重取快照再订阅。本阶段没有提供 `Last-Event-ID` 的历史重放协议。模型请求事件携带模型、强度和实测 usage；没有来源的数据不伪造。Codex reasoning 只公开摘要，加密体标记不可用。

## 官方 trace

`CODEX_TRACE_RETENTION_DAYS` 默认 14，0 禁用新 trace 并移除继承的 trace 环境变量。启用时 runner 创建 `${CODEX_HOME}/trace`，精确设置 `CODEX_ROLLOUT_TRACE_ROOT`；变量名称依据绑定调研文档对 Codex 0.163.0 的核验。本地没有 Codex npm 包，未额外运行真实 Codex 请求。

清理与现有 ObsStore 每日 purge 一起执行，只删除 trace 根目录内 mtime 超过保留期的普通文件，不跟随符号链接，不删除目录。关闭 trace 不删除现存历史。本组不部署、不修改 `.env`，也不在开发验证中写入仓库 `data/`。

## Git Bash 调用示例

```bash
BASE=http://127.0.0.1:8787
# OBS_TOKEN 从现有安全配置取得；此处只用 cookie，不将令牌写入 URL。
curl -sS -b "obs_token=$OBS_TOKEN" "$BASE/api/agents"
curl -sS -b "obs_token=$OBS_TOKEN" "$BASE/api/agents/codex/sessions?status=active&scope=owner&page=0"

# 将 SID、TURN 和 REF_* 替换为上述接口实际返回值。
curl -sS -b "obs_token=$OBS_TOKEN" "$BASE/api/agents/codex/sessions/$SID"
curl -sS -b "obs_token=$OBS_TOKEN" "$BASE/api/agents/codex/sessions/$SID/turns/$TURN"
curl -sS -b "obs_token=$OBS_TOKEN" "$BASE/api/agents/codex/sessions/$SID/content?offset=$REF_OFFSET&length=$REF_LENGTH"
curl -N -b "obs_token=$OBS_TOKEN" "$BASE/agents/stream?backend=codex&session=$SID"
```

Pi 使用相同接口，将 backend 改为 `pi`，会话 ID 使用返回的数字字符串。

## 验证范围

匿名 fixture 保留真实 rollout 的字段结构，使用固定测试正文与事件序列，替换身份、路径、工具正文、QQ 号和加密体；补充构造样本覆盖压缩、多请求、超大行、截断、追加和凭据边界。测试还覆盖 50 MiB 流式索引、索引重启恢复、Pi 假源与真实公开接口、所有新路由的鉴权与范围限制、两后端 SSE、trace 环境变量与每日清理。

本次宿主实际 Node 为 v24.15.0，依赖和 package.json 既有 engine 要求为 Node >=24；未修改 Node 版本要求。没有新增运行时依赖。最终命令与计数记录在设计文档 §9。
