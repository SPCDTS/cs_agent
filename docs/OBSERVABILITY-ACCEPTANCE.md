# 第 4 组观测系统验收

2026-10-18，在 Windows / Node 24 上完成。未停止、重启或替换运行容器；只构建 `cs-agent:g4`。没有调用真实模型、Codex、QQ 或 ComfyUI；测试使用 fake CLI、faux 模型、假 bridge 与本机临时 HTTP 服务。未修改 `.env`、seccomp 配置和设计稿，未修改或暂存 `src/qq/**`、`test/qq/**`。

> 2026-10-19 更新：回复后处理已移除 relay，两后端均只做代码清洗；postprocess 阶段保留，不再发出 relay 模型调用或其 fallback 事件。下文保留原验收记录，历史事件与用量仍可读取、聚合。

> 2026-10-22 更新：常驻 agent（[常驻 agent 设计](DESIGN-resident-agent.md)）取代了票据派发：dispatcher 与 durable 任务阶段事件、`fallback` / `no_send_fallback` 终态及"连续三条票据失败"告警的口径仅作历史记录；现在终态按回合记录，告警改为连续三个回合失败。

> 2026-10 更新：本地 ComfyUI 生图已移除（pi 的 `generate_image`、codex 的 `image_gen` MCP、`image:submit / image:collect` 事件、ComfyUI 健康检查与 `comfy_job_duration_ms` 指标）；下文涉及生图的条目仅作历史记录。

## 文件

| 逻辑组 | 文件 |
|---|---|
| 观测基础 | `src/obs/{store,trace,redact,metrics,image,alerts}.ts`、`src/log.ts`、`test/obs/store.test.ts` |
| 全链路埋点 | `src/agent/{dispatch,tasks,codex-runner,reply-postprocess}.ts`、`src/agent/backends/{codex,pi}.ts`、`src/agent/pi-tools/{index,images}.ts`、`src/context/aging.ts`、`src/mcp/{image-gen,image-gen-server}.ts`、`test/obs/instrumentation.test.ts` |
| 面板与接线 | `src/obs/http.ts`、`src/main.ts`、`src/config.ts`、`src/context/store.ts`、`test/obs/http.test.ts`、`scripts/verify-observability.mjs` |
| 配置与说明 | `.env.example`、`docker-compose.yml`、`docs/DEPLOY.md`、`docs/ARCHITECTURE.md` §10.4、本文 |

现有文本文件先检查 UTF-8 / BOM / 换行；`.env.example` 和 `ARCHITECTURE.md` 保留 CRLF，其余现有修改文件保持原 LF，无新增 BOM。Compose 仅增加 loopback 端口发布和 `HEALTH_HOST: 0.0.0.0`。

## 实际事件

事件保留开始、成功或失败状态；同一 span 会有起止两行。以下按业务顺序列出，省略重复的起止名称。

| 路径 | 阶段 |
|---|---|
| 所有新票据 | `received → admitted → routed → dispatched` |
| 前缀图片 | `phase:submit → image:submit → phase:collect → image:collect → phase:reply → reply_sent`；正常终态再写 `reply_sent(terminal=true)`；业务失败则写 `failed(terminal=true)`，即使错误模板已成功发送 |
| 空图片提示词 | `phase:submit → phase:reply → reply_sent`，不会调用图片或模型后端 |
| Codex agent | `phase:handle → backend:codex → model_turn → tool:<name> → model_turn → backend:codex → late_images → postprocess → phase:reply → reply_sent`；JSONL 另发 `model_usage`，线程创建另发带 thread_id 的 `dispatched` |
| Pi agent | `phase:handle → backend:pi → dispatched`，GenerationTask 每次请求/响应发 `model_turn`，工具 hook 发 `tool:<name>`；之后走 `late_images → postprocess → phase:reply → reply_sent`；压缩 hook 另发 `compaction` |
| agent 内生图 | Pi 进程内工具和 Codex 独立 image_gen MCP 都发 `image:submit / image:collect`；包含 prompt_id，独立 MCP 写相同 WAL 库 |
| 延迟收图 | `late_images` 内按需发 `image:collect`；对账使用 `image:collect(operation=reconcile)`，每个查询步骤发 `recovered`；不重新提交图片 |
| 恢复 | dispatcher、Codex 已保存输出、Pi 已有请求及图片对账发 `recovered`；阶段起止包含当前 checkpoint / attempt |
| 失败与兜底 | 原 span 记 `status=failed` 和错误类别；最终失败发 `failed`，发送兜底发 `fallback(terminal=true)`；relay 格式整理失败发 `fallback(terminal=false)`，不影响票据成功率 |
| 衰老 | `@aging` 的 `model_turn` 记录摘要用量；调度完成或失败发 `aging` |

新增测试直接断言 image / Codex agent 经 dispatcher 的阶段顺序，另验证 Pi 的两次模型响应与历史工具 hook、假 CLI JSONL 的 MCP 工具失败与 42 ms 耗时、agent 延迟收图的 prompt_id 与附件数、对账 recovered、错误模板发送后的超时票据分类。

## HTML 验收（无截图）

执行 `node scripts/verify-observability.mjs`：随机 loopback 端口、临时假数据，八页均 HTTP 200。实际响应 UTF-8 字节数如下；示例事件时间戳和 CSP nonce 会变，字节数保持相同长度。页面没有外部 CDN 或前端框架。

| 页面 | 字节数 | 文字说明 |
|---|---:|---|
| `/` | 2121 | 深色页面、顶部导航；健康 JSON、1h/24h 吞吐卡片、队列与指标区域 |
| `/tickets` | 1945 | 状态/会话/路由/后端筛选表单；四列表格，票据可点击，前后分页 |
| `/tickets/example` | 2498 | 纵向时间线，每阶段显示状态、时间、耗时与脱敏详情；下方图片区域 |
| `/logs` | 1770 | ticket 与 level 筛选、等宽日志区域；少量内联 JS 用 SSE 更新 |
| `/context` | 1575 | scope 下拉选择、关键词输入和共享格式化输出 |
| `/codex` | 1473 | 线程键/id、rollout 大小、观测回合数，以及 AGENTS.md 区域 |
| `/pi` | 1370 | 会话数量/键、压缩与用量区域 |
| `/config` | 4759 | 脱敏配置、agent.md 修改时间和正文区域 |

HTTP 测试另覆盖 HTML 转义、共享 formatter 输出一致性、真实图片响应、编码路径穿越 / Windows 路径 / junction / 假图片拒绝、口令保护图片与 SSE、HttpOnly cookie 与移除 URL 口令、SSE 过滤后实时发出日志。

## 最终命令结果与原始尾部

全部退出码为 0。首次在受限 Windows 沙箱内跑完整测试时，Git Bash 临时目录写入及 taskkill 受到权限限制，导致 17 项失败；在获准的沙箱外复跑后通过，未修改断言或降低测试要求。下面记录最终复跑尾部。

`npm run typecheck`：

```text
> cs-agent@0.1.0 typecheck
> tsc -p tsconfig.json --noEmit && tsc -p tsconfig.test.json --noEmit
```

`npx vitest run`：

```text
 Test Files  34 passed (34)
      Tests  445 passed (445)
   Start at  05:39:17
   Duration  43.18s (tests 89%, import 11%)
```

`npm run build`：

```text
> cs-agent@0.1.0 build
> tsc -p tsconfig.json
```

`docker build -t cs-agent:g4 .`：

```text
#26 exporting manifest sha256:e45329302a1feb14c4bccc77f40898e4a27fed7f0b5d5b5eeb0732c7e7ebcdbf 0.0s done
#26 exporting config sha256:f65dfe4ba2e82f667da46431798caf22cef6c4b0705ecca2d64d105293a615e6 0.0s done
#26 exporting attestation manifest sha256:9a8afe9b75ad073f9baa1e7755b4d2ba18957101bb2e3274125d56ec2c233135 0.0s done
#26 exporting manifest list sha256:6c1e3a9cf9e99fa86ec9ee4f42fd74b0caaedf28d9fce0125e9398b1d3f6eb4a 0.0s done
#26 naming to docker.io/library/cs-agent:g4 done
#26 unpacking to docker.io/library/cs-agent:g4 0.1s done
#26 DONE 0.5s
```

`docker compose config -q`：无输出，退出码 0。

## 边界与未覆盖项

- 未部署到运行容器，未做真实 QQ / 模型 / ComfyUI 冒烟；面板需在后续部署新镜像后才对现用流量生效。
- ComfyUI / Codex 健康显示启动检查快照；DeepSeek 仅检查密钥是否存在。Pi 压缩统计是尝试数，未宣称成功次数；Codex 回合数仅覆盖观测保留期。
- 费用默认 0，需配置单价；估算不包含搜索/抓页费用，不区分缓存优惠。Pi 工具回合记录可获得的缓存用量；relay / 衰老当前只记录输入和输出用量。
- 事件为尽力记录，与业务事务独立；崩溃边界可能缺失或重记事件。指标游标与窗口结果同事务保存，已写事件可继续聚合。原始/发送正文和提示词仅保存脱敏后最多 500 字。
- `OBS_RETENTION_DAYS` 只清理观测 events / metrics；不删除业务 failed 派发索引，以免旧 pending 票据在恢复时被当作孤儿重跑。
- 日志环形缓冲重启清空；现有 Docker stderr 日志保留机制不变。
