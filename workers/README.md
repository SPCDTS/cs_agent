# Workers P1a

NapCat 的 OneBot v11 Universal 反向 WebSocket 连接 `/onebot`。Bridge DO 单例 `napcat` 负责授权、去重、群名与发送规则；群消息进入 `group:<群号>` 的 Thread DO，owner 私聊仍共用 `owner`，其他允许用户进入 `private:<QQ号>`。Thread 中运行 pi-durable，保存消息与回合，工具调用经同一条反向 WS 回复 QQ。

## 配置与行为

| 配置 | 类型与用途 |
| --- | --- |
| `NAPCAT_TOKEN` | secret；未设置时 `/onebot` 返回 401，支持 Bearer / query token |
| `QQ_OWNER` | secret，逗号分隔；owner 在任何会话可通过授权检查，群内仍需真实 @ |
| `QQ_ALLOW_USERS` | 可选 secret，逗号分隔；允许私聊，沿用原策略也允许这些用户在其他群真实 @ 后触发 |
| `QQ_ALLOW_GROUPS` | 可选 secret，逗号分隔；允许群内所有成员的消息入库，真实 @ 机器人时才触发 |
| `QQ_GROUP_MENTIONS` | var，默认 `true`；设为 `false` 时群消息仍入库，但不启动回合，包括 owner |
| `MODEL_PROVIDER` / `MODEL_ID` | `faux` / `deepseek` / `magpie` 及对应模型；测试始终用 faux |
| `MAGPIE_URL` | `container` 使用现有 MagpieContainer；外部网关使用 OpenAI 兼容根地址 |
| `DEEPSEEK_API_KEY` / `MAGPIE_GATEWAY_KEY` | 既有模型 secrets |
| `R2_*` / `MAGPIE_SYNC_PASSPHRASE` | 既有容器状态同步 secrets |
| `CS_AGENT_COMMIT` | 健康检查中的构建标识 |

QQ 列表默认空；非法 ID 被忽略，不支持通配符。文件上传等 notice / 系统事件不作为聊天输入；字符串形式的 CQ 码不解析，文本 `@昵称`、引用和 `@全体成员` 均不能冒充真实 `at` 机器人。正文保留 `[@你]`、`[reply]`、`[image]` 等标记，引用 ID 单独落库，昵称和群名折成单行。

`scripts/put-secrets.sh` 从 `.env` 增加读取两个可选白名单。缺项或空值跳过，不影响原有七个必需 secrets。**跳过不等于删除已部署的 secret**，清空现有线上配置需另行显式删除。此次没有执行真实 secrets 上传。

## 数据与回合

- Bridge 的 SQLite：`seen` 保存 `self_id:type:group:user:message_id`，最近 5000 条；`threads` 记录已见会话。相同平台消息 ID 在不同发送者或会话中不会共用入站键。
- 群名通过 `get_group_info` 获取，成功结果持久缓存 6 小时；失败保留旧名并负缓存 1 分钟。群消息按会话依次入库和提交，查名不会挡住 WS 回执。
- Thread 的 `messages` 保留 `UNIQUE(scope, message_id)`；`messages_fts` 使用 FTS5 trigram 与 INSERT / UPDATE / DELETE 三个同步触发器；`scope_names` 保存群名。非触发消息也入库。发送成功后的 outbox 回执与 `is_self=1` 消息在同一事务提交。
- `qq_context({ query?, limit?, before? })` 只读本回合的 scope。默认最近 20 条，最多 50 条；`before` 为严格小于的 Unix 秒时间戳。三字以上走字面短语 FTS；一、两字走转义后的 LIKE。最近记录旧到新，搜索结果新到旧；北京时间、昵称(QQ号)、正文按紧凑格式输出，总量至多 2500 字符。
- owner 多个账号共用 Harness，但召回工具仍限定当前私聊账号的 scope。其他群或私聊的历史不提供跨 DO 查询入口。
- 身份提示与工具目标均经 `LiveDoc.run.inputs → submission.requestId → inbound` 查找，避免用最新入站消息误绑定当前回合。系统提示包含 owner / 群成员 / 私聊用户、昵称、会话名称与 ID，以及发送约束和不可信内容规则。
- 群回复固定回本群，发送 `at` 段和文本段；私聊固定回输入账号。模型不能传入其他目标。
- 忙时同一 QQ 发送者使用 `whenBusy: "steer"`；不同发送者使用 `followUp`。已有其他成员排队时，后来消息也排队，保证到达顺序。宿主只串行接纳，不等待前一回合结束后才接纳。
- P0 表通过增列迁移，保留旧 `message_id` / requestId；新行使用复合入站键，并用 `platform_message_id` 保留 QQ 消息 ID。冷启动按行顺序幂等重投 queued 输入。

## 发送规则与健康检查

| 规则 | 行为 |
| --- | --- |
| 每会话每分钟 6 条 | 第 7 条拒绝，工具结果包含“发送过快” |
| 每会话每小时 60 条 | 超出后熔断该会话 60 分钟 |
| 全局每分钟 30 条 | 超出后熔断全部会话 10 分钟 |
| 单条 1～4000 字符 | 超长或空消息拒绝，不截断 |

`send_log(scope, at)` 与 `send_breakers(scope, until, tripped_at, reason)` 都在 Bridge SQLite。检查与占用额度在同步事务里完成，被拒消息不计数；已接纳发送即计数，即使随后回执失败或超时。限额使用实际 `group:` / `private:` 目标，不把多个 owner 私聊账号合成一个发送目标。熔断到期后从新窗口计数，保留过期熔断行作为窗口边界。

`GET /healthz` 保留 `bridge`、`model`、owner 的 `thread` 计数，新增顶层 `threads`（最近见过的会话键，最多 50 条）和 `sendRules`（当前熔断数组）。模型不可用仍返回 HTTP 503；熔断本身不改变 HTTP 状态。

## 文件变更

| 文件 | 改动 |
| --- | --- |
| `src/policy.ts`（新增） | 参数化移植消息规范化、允许与触发规则、目标及入站键 |
| `src/send-rules.ts`（新增） | Bridge SQLite 的限速、熔断与过期窗口 |
| `src/context.ts`（新增） | 消息 schema、入库、FTS/LIKE 召回、紧凑格式 |
| `src/prompt.ts`（新增） | 发送、安全与本回合身份提示 |
| `src/bridge.ts`、`src/onebot.ts` | 群路由、所有允许消息入库、去重、查名、通用 echo API、群发送 |
| `src/thread.ts` | P0 增列迁移、回合绑定、消息库、召回工具、steer / followUp |
| `src/env.ts`、`src/index.ts` | 环境类型、健康检查新增字段 |
| `scripts/put-secrets.sh` | 两个可选白名单 secrets |
| `wrangler.jsonc`、`wrangler.test.jsonc` | 同步增加 `QQ_GROUP_MENTIONS` var；未新增 DO 或迁移类 |
| `worker-configuration.d.ts` | 按生产 Wrangler 配置重新生成类型 |
| `vitest.config.ts`、`test/worker.test.ts` | 合成白名单绑定及 P0 回归测试适配 |
| `test/helpers.ts`（新增） | 合成 OneBot 事件和反向 WS 测试工具 |
| `test/policy.test.ts`、`test/groups.test.ts`、`test/context.test.ts`、`test/send-rules.test.ts`（新增） | P1a 的 workerd / SQLite / faux 集成测试 |
| `README.md` | 本说明与测试对照 |

## 验证与用例对照

命令全部在 `workers/` 执行，Windows 使用 `.cmd` shim：

```text
npx.cmd wrangler types
Types written to worker-configuration.d.ts

npx.cmd tsc -p tsconfig.json --noEmit
退出码 0，无类型错误

npx.cmd vitest run
Test Files  6 passed (6)
Tests       35 passed (35)
```

| 功能 | 用例（test/ 下） |
| --- | --- |
| 规范化、引用、图片、名称清洗 | `policy.test.ts`：`renders at, reply and image segments and sanitizes display names` |
| 真实 @、owner / allowUsers / groupMentions | `policy.test.ts`：`requires a genuine bot at segment and honors groupMentions`、`ports owner and allowUsers exemptions and routes owners to one private thread` |
| 非法帧、文件等系统事件 | `policy.test.ts`：`ignores system events and malformed IDs without interpreting string CQ messages`；`worker.test.ts` 的非法帧回归 |
| 群消息无 @ 只入库 | `groups.test.ts`：`ingests allowed group chatter without starting Pi and persists the cached group name` |
| 群 @ 回复、机器人入库、身份安全提示、驱逐后去重 | `groups.test.ts`：`replies to a real group mention with at, records self history, and deduplicates across eviction` |
| 不允许群忽略、allowUsers 私聊 | `groups.test.ts`：`ignores disallowed groups and admits allowUsers private messages` |
| 群名 TTL | `groups.test.ts`：`refreshes group names only after the six-hour cache expires` |
| 多人排队和正确收件人 | `groups.test.ts`：`queues different senders in arrival order and keeps each turn identity and at target`；`worker.test.ts` 的 queued 收件人回归 |
| 同人插话 | `groups.test.ts`：`submits same-sender followups with steer while the current tool is waiting`，验证两条输入由同一个最终 answer 结算 |
| 插话不越过已排队的成员 | `groups.test.ts`：`does not let a same-sender followup overtake an already queued member` |
| 去重 5000 / health threads 50 上限 | `groups.test.ts`：`bounds bridge deduplication to 5000 and health thread listings to 50` |
| 分钟限速与长度 | `send-rules.test.ts`：`accepts six concurrent sends and rejects the seventh without counting it`、`rejects 4001 characters before sending and permits exactly 4000` |
| 小时熔断、持久化、health sendRules、到期恢复 | `send-rules.test.ts`：`persists the hourly breaker, exposes it in healthz and resets the expired window` |
| 全局熔断 | `send-rules.test.ts`：`trips the global minute breaker across scopes and blocks other chats for ten minutes` |
| trigram、两字 LIKE、时间边界、scope 隔离、消息唯一性 | `context.test.ts`：`searches trigram and two-character Chinese terms with before and scope isolation` |
| FTS 更新/删除与 50 条上限 | `context.test.ts`：`maintains FTS triggers on update/delete and caps recall to fifty messages` |
| 实际 qq_context 工具和 owner 身份 | `context.test.ts`：`executes the read-only qq_context tool inside Pi with current-turn scope and owner identity` |
| 拒绝原因确实返回模型，失败不写回执或机器人历史 | `context.test.ts`：`returns send-rule rejections to the model without self history or outbox receipts` |
| P0 表升级 | `context.test.ts`：`migrates the P0 inbound table without losing request IDs or replaying completed inputs` |
| 鉴权、断线、重连、echo 失败、实际 15 秒超时 | `worker.test.ts` 中原有 9 项回归 |
| provider 与目录失败 | `models.test.ts` 中原有 5 项回归 |

secrets 脚本另做离线 Bash 检查：`bash -n` 通过；在任务临时目录中用替身 `npx` 截获 stdin，验证 `missing` / `empty` 两种夹具都只包含原七项，`filled` 包含九项及两个合成白名单。没有读取真实 `.env`、调用真实 secret 上传或连接 NapCat。

当前工作树原本没有 `node_modules`，离线复制主工作区的现成依赖后运行测试，没有 npm install、网络取包、修改锁文件或提交 Git。原有 UTF-8、无 BOM 文件保留其换行：工作树多数文件为 CRLF，shell 脚本为 LF；新文件使用 UTF-8 无 BOM、LF。

## P1a 简化与注意事项

- 不含跨会话召回、媒体下载/上传、摘要、历史清理、记忆、审批、子 agent、定时任务或可靠 outbox 重发。`SEND_RULE` 移植了可见回复、去重与长度约束，删除了未实现的附件和子 agent 能力描述；`PI_SAFETY_RULE` 保留原文。
- 只按同一个 QQ ID 判定插话身份；owner 多账号共用 Thread，但不同账号仍各排一轮。每次群工具发送都带 @，尚未实现“一轮只在第一条 @”。
- 历史工具只读 scope；owner 共用 Harness 的既有模型上下文仍然共享，这不是账号之间的完整安全隔离。
- Bridge 的 echo 等待和投递 Promise 仍在内存。API 有 15 秒上限，finally 清理计时器；等待时保持活动，空闲后可休眠。群名查询失败不会丢弃聊天。进程在 Bridge 去重落盘后、Thread 接纳前中断仍有投递窗口，P1a 没有持久化 Bridge 发件队列。
- 出站确认超时、断线或缺少消息 ID 时结果不确定，`replay: "unsafe"` 防止自动重复发送；outbox 只记确认成功。`inbound.done` 代表回合正常结束，不能等同于 QQ 发送成功。
- Thread 宿主 SQL 必须经过 `DurableObjectSqliteDatabase` 共享队列；事务内用回调的 `tx`，不能再调用外层 database。Bridge 没有 Pi，可使用原生同步 SQLite 事务；拒绝时返回原因后再抛错，避免把刚写入的熔断回滚。
- 当前 pi-durable README 把提交调度放在 `Busy Conversations`；API 实际选项是 `steer` / `followUp`，没有 `queue`。结算后的 submission 不保留 mode，插话验证应检查共享 answer 或在途 inbox。
- `harness.submission` 是异步接口；身份不能用“最近 queued 行”。工具必须返回 `output` 才能让模型看到召回内容与拒绝原因。FTS trigram 对一、两字没有 token，必须回退 LIKE。
- vitest-pool-workers 0.23 需要 `cloudflareTest`；配置继续使用已安装 Wrangler 的 workerd，以匹配部署的兼容日期。负向 RPC 测试会输出预期 workerd exception，Vitest 没有未处理错误；包改名提示也不影响通过。
- Wrangler 生成类型以生产配置为准，会重写文件换行；生成后恢复原 CRLF。`Env` 放宽 var 的字面量类型，测试才能覆盖 faux 等配置。

按任务要求未做本地真实 NapCat 冒烟，也未改 workers/ 之外的项目文件。
