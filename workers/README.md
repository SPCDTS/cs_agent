# Workers P0

NapCat 的 OneBot v11 Universal 反向 WebSocket 连接 `/onebot`。Bridge DO 单例 `napcat` 接收事件，允许的 owner 私聊交给 Thread DO `owner`；pi-durable 调用 `send_message` 后，经同一条连接发出 `send_private_msg`。

## 文件与配置

- `src/index.ts`：只保留 `/onebot`、`/healthz`，移除 `/spike`；Bearer / query token 鉴权。
- `src/bridge.ts`、`src/onebot.ts`：Hibernation API、连接替换、消息段解析、owner 过滤、echo 回执与 15 秒超时。
- `src/thread.ts`：共享 SQLite 操作队列、入站去重、回合恢复、当前 submission 收件人绑定、发送审计。
- `src/models.ts`、`src/magpie.ts`、`src/env.ts`：provider 选择、网关目录与 secret 类型。
- `wrangler.jsonc`：保留 v1 ThreadDO 迁移，新增 v2 BridgeDO 迁移；`worker-configuration.d.ts` 由 Wrangler 生成。
- `vitest.config.ts`、`test/*.test.ts`、`tsconfig.json`：严格类型检查与真实 workerd / SQLite 集成测试。
- `scripts/fake-napcat.mjs`：Node 24 内置 WebSocket 冒烟客户端。
- `.gitignore`：排除本地状态、依赖与 secret 文件。

没有修改根目录 package.json、src、依赖清单或锁文件，没有安装依赖或提交 Git。原有文本文件保持 UTF-8、无 BOM、LF。

| 配置 | 用途 |
| --- | --- |
| `QQ_OWNER` | 逗号分隔的 QQ 号；默认空，拒绝全部私聊 |
| `MODEL_PROVIDER` | `faux` / `deepseek` / `magpie` |
| `MODEL_ID` | 默认 `test`；切换 provider 时也要改模型 ID |
| `MAGPIE_URL` | OpenAI 兼容 API 根地址，例如 `https://gateway.example/v1` |
| `CS_AGENT_COMMIT` | 健康检查中的构建标识 |
| `NAPCAT_TOKEN` | secret；未设置时 `/onebot` 始终返回 401 |
| `DEEPSEEK_API_KEY` | DeepSeek secret |
| `MAGPIE_GATEWAY_KEY` | Magpie secret；也用于目录鉴权 |

安装的 pi-ai 1.4.0 已使用 `deepseek-flash` 等模型 ID，目录中没有旧的 `deepseek-chat`。Magpie 的 MODEL_ID 必须与启动时拉到的目录完全一致。目录请求失败或模型不存在时，`/healthz` 返回 HTTP 503、`ok: false`、`model: "unavailable"`，不泄露网关正文。

## 验证结果

所有命令均在 `workers/` 执行：

```text
npx.cmd wrangler types
Types written to worker-configuration.d.ts

npx.cmd tsc -p tsconfig.json --noEmit
退出码 0，无输出

npx.cmd vitest run
Test Files  2 passed (2)
Tests       14 passed (14)
Duration    20.37s
```

用例覆盖两种鉴权、完整工具回合和 outbox、重复消息等待 1 秒、非 owner / 群聊过滤、非法帧、Bridge 休眠后恢复、Thread 驱逐后去重及后续回合、排队输入的收件人、断线工具结果、重连替换、echo 关联、失败回执、实际 15 秒超时，以及三类 provider 与 Magpie 目录失败。

测试输出包含包改名提示和负向 RPC 用例预期的 workerd 异常日志；Vitest 无未处理错误，退出码为 0。外部模型 HTTP 用测试响应代替，没有联网调用 DeepSeek 或真实 Magpie。

## 本地冒烟

准备仅含测试值的临时 env 文件，提供 `NAPCAT_TOKEN`、`QQ_OWNER=10000001`、`MODEL_PROVIDER=faux`、`MODEL_ID=test`。token 不进入源码；测试时使用临时随机值。

```powershell
# Windows 沙箱下，日志和开发注册目录也要指向可写临时目录。
$env:WRANGLER_SEND_METRICS = 'false'
$env:XDG_CONFIG_HOME = '<临时目录>\wrangler-config'
$env:WRANGLER_LOG_PATH = '<临时目录>\dev-wrangler.log'
npx.cmd wrangler dev --port 8789 --ip 127.0.0.1 --inspector-port 0 --env-file '<临时目录>\smoke.env' --persist-to '<临时目录>\smoke-state'

# 另一个终端，同样在 workers/ 中执行。
node --env-file='<临时目录>\smoke.env' scripts/fake-napcat.mjs
```

2026-10-29 本地成功运行的实际帧如下；只记录合成测试消息：

```text
SEND {"post_type":"meta_event","meta_event_type":"lifecycle","sub_type":"connect","self_id":42}
SEND {"post_type":"message","message_type":"private","self_id":42,"user_id":"10000001","message_id":1793205507727,"time":1793205507,"message":[{"type":"text","data":{"text":"P0 smoke"}}]}
RECV {"action":"send_private_msg","params":{"user_id":"10000001","message":[{"type":"text","data":{"text":"echo: P0 smoke"}}]},"echo":"29578b61-3fdb-4799-8957-6d93b9a91075"}
SEND {"status":"ok","retcode":0,"data":{"message_id":99},"echo":"29578b61-3fdb-4799-8957-6d93b9a91075"}
HEALTH {"ok":true,"commit":"dev","bridge":{"connected":true,"selfId":"42","ignored":0},"model":{"provider":"faux","id":"test"}}
PASS: owner round trip and duplicate suppression
```

客户端重发相同入站帧并等待 1 秒，确认只有一条 API 请求。Wrangler 记录 `/onebot` 为 101、`/healthz` 为 200。冒烟结束后停止本次开发服务。

## P0 简化

- 所有允许的 owner 共用一个 `owner` 会话；只处理私聊文本，忽略图片等段，空文本不启动回合。
- Bridge 的未决调用只存在内存 Map；没有持久化 echo 等待表，没有断线自动重发。发帧后断线或超时属于结果不确定，禁止盲目重试。
- outbox 只记录已确认发送的消息，不是可靠重试队列；一次回合只发一条由系统提示约束，尚未增加限流或强制发送次数限制。
- `inbound.status` 表示模型回合是否完成；模型收到 `channel_down` 后仍可正常结束，所以 `done` 不等于 QQ 发送成功，以 outbox / 工具结果为准。
- Harness 在下次打开时恢复，宿主 queued 行以 requestId 幂等重投；没有 alarm 主动唤醒，冷启动后的重复消息本身只返回 deduped，后续新输入或健康检查才触发恢复。
- Magpie 只在 Harness 初始化时拉目录，不做持久缓存或自动降级；失败后的下次打开会重试。健康检查确认配置和目录可用，不是上游生成请求探针。
- 不包含 Registry、群会话、媒体、记忆、审批、发送规则和子 agent。

## API 与环境踩坑

1. `fauxAssistantMessage(fauxToolCall(...))` 默认仍为 `stop`，必须显式传 `{ stopReason: "toolUse" }`。`setResponses` 中的工厂也是一次性消费，工厂需补回自身，才能持续处理新回合和工具续轮。
2. 工具结果必须通过 `output` 返回给模型；直接返回业务对象不会成为模型看到的结果。`replay: "unsafe"` 避免中断后重复发送。
3. pi-durable 的宿主 SQL 必须经过 `DurableObjectSqliteDatabase`。其 Cloudflare 适配器按相同 storage 对象共享操作队列；直接写 `ctx.storage.sql` 会绕过 Pi 的事务队列。
4. DO RPC 在 await 处可以交错，不能用“最近 queued 的 user_id”作为当前回合收件人。本实现用 `LiveDoc.run.inputs` → submission.requestId → inbound 查出当前输入。
5. `harness.submission(id, context)` 返回 Promise；faux 的 provider API 名字也会在重新创建时改变，需通过持久化 conversation 和重新注册 provider 恢复，已测过驱逐后的第二轮。
6. vitest-pool-workers 0.23 / Vitest 4 不再导出 `defineWorkersConfig` 和 `fetchMock`，改用 `cloudflareTest` 与 Vitest 的 HTTP 边界替身。pool 内置的 workerd 只支持到 2026-08-22，配置复用当前已安装 Wrangler 的 workerd，以便仍按部署兼容日期 2026-10-01 测试。
7. Vitest 的 `rejects` 直接接收 Workers RPC thenable 时会产生额外的拒绝链；测试先 await 成普通 Promise，再断言错误。workerd 仍会打印预期远程异常，但 Vitest 不再报未处理拒绝。
8. Windows 同一工作树原有 Wrangler 仍占用 8789；确认归属后停止旧服务，重新启动。默认日志 / registry 目录不可写，改用临时目录；固定 inspector 端口也发生冲突，使用 `--inspector-port 0`。
