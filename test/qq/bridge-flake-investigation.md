# QQ bridge 偶发失败排查

## 结论与证据

2026-10-18，在 Windows、Node 24.15.0、Vitest 5.0.5 上复现。
假服务器的 `listen(0)` 偶尔拿到 Fetch 禁止访问的端口，导致发送在进入 HTTP 服务前失败。
这次捕获的失败不是 2 秒超时：发送请求仅耗时 0.116–0.212 毫秒，信号未中止，服务器请求记录为空。

`netsh int ipv4 show dynamicport tcp` 显示当前机器动态端口范围为 1024–15000。
Node 自带 Undici 的 `badPorts` 列表包含此范围内的 1719、4045、6000、6566、6667、6668、6697、10080 等端口。
该列表直接从本机 Node 的 `internal/deps/undici/undici` 内置源码核对，没有访问外网。

修复前对目标测试连续执行 5000 次，保留系统自然分配端口，共捕获 **11 次同一发送断言失败**。
实际失败端口为 1719、4045、6566、6667、6668、6697，11 次底层错误均为 `TypeError: fetch failed`，`cause.message = "bad port"`。
其中一次诊断记录（没有记录请求头、凭据或消息正文）：

```json
{"action":"/send_group_msg","port":"4045","elapsedMs":0.1452999999964959,"name":"TypeError","message":"fetch failed","cause":"bad port","aborted":false,"actions":[]}
```

Vitest 捕获的原始断言及完整原因：

```text
FAIL test/qq/bridge.test.ts > send > sends plain text to group and private
AssertionError: promise rejected "OneBotError: 无法连接 NapCat HTTP 服务或请求超时（sen… { uncertain: true }" instead of resolving
Caused by: OneBotError: 无法连接 NapCat HTTP 服务或请求超时（send_group_msg）；消息可能已经发出，不要重试，请先查看聊天记录确认。
```

固定使用 6000 端口时，也确定性复现了同一断言。`start()` 中的登录 HTTP 失败被捕获后仍会建立 WebSocket，
因此等待 `connection` 并不能检测这种 HTTP 不可达情况；真正的群发送随后才使测试失败。

已核对其他候选原因：原测试本来就等待 `connection`；每次测试新建服务器实例并使用 `mkdtempSync` 创建独立目录；
直接发送走 HTTP，不依赖票据 SQLite 或入站事件顺序。首轮普通全套未复现目标失败，后续增加重复次数才捕获自然分配的禁用端口。
观察到的“只在负载下失败”不足以证明定时竞争；增加超时不能让 Fetch 接受禁用端口。

## 修复

- `fake-onebot.ts` 在公布 HTTP 地址前跳过 Fetch 禁用端口及低于 1024 的端口。
- 被跳过的监听器保留到选出新端口，防止系统立即再次分配同一个端口；成功或失败离开分配流程时统一关闭。
- `fake-onebot.test.ts` 确定性模拟系统先后返回 6000、10080，验证重选、保留与释放监听器，以及最终登录、群发、私发均正常。
  真实监听仍使用系统分配的端口，回归测试不占用固定端口，也不靠概率触发。
- 保持原有 2000 毫秒 HTTP 超时、WebSocket 等待和目录隔离；不修改生产逻辑、容器或其他任务的文件。

## 验证方式

所有 HTTP/WebSocket 请求仅访问本地测试桩。全套需要在 Windows 沙箱外运行：沙箱内另有 shell 临时文件写入和进程树终止限制。
排查中的原生 worker 退出（3221226505）单独记录，不作为本次发送断言或超时的证据。

```powershell
npx.cmd --no-install vitest run --silent=passed-only
npx.cmd --no-install vitest run test/qq/bridge.test.ts --sequence.shuffle --pool=threads --maxWorkers=2 --silent=passed-only
npx.cmd --no-install vitest run test/qq/bridge.test.ts --testNamePattern="sends.plain.text.to.group.and.private" --repeats=4999 --silent=passed-only
npm.cmd run typecheck
```

第二条命令独立运行十轮，同时在另一进程循环执行 `npm.cmd run build` 产生 CPU 负载。
构建负载持续 100 秒，74 次构建全部成功，覆盖十轮 bridge 运行。
用户给定的 `--poolOptions.threads.singleThread=false` 在本仓库 Vitest 5 中报 `Unknown option --poolOptions`，
因此使用支持的 `--pool=threads --maxWorkers=2`。全套验证沿用仓库默认的 forks 和 2-worker 配置。

自然失败复现使用临时只加载 bridge 的配置，跳过全局构建，因为另一任务当时正在修改代码并造成短暂的类型检查错误。
修复后的验收使用仓库原配置及全局构建。临时诊断、探针测试、运行脚本和日志在提交前移除。

## 验收结果

| 验证 | 结果 |
| --- | --- |
| 修复后全套连续五轮，默认 forks / 2 workers | 5/5 通过，每轮 34 个文件、443 项测试 |
| 并行构建负载下 bridge 独立乱序运行十轮，threads / 2 workers | 10/10 通过，每轮 30 项测试 |
| 确定性禁用端口回归测试 | 单独通过，并包含在上述五轮全套内 |
| `npm.cmd run typecheck` | 通过 |

额外尝试将同一发送测试重复 5000 次，threads 和默认 forks 两种模式均遇到原生退出 3221226505，未完成整轮。
这两次运行不计为通过，也不宣称修复后完成了 5000 次对照。上表要求的五轮全套和十轮压力验证均完整通过。
