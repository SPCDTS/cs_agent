# 早报技能发布与订阅源恢复

## 技能发布

技能修改先保存到 `/work` 持久工作区，再检查固定版本并发布：

```javascript
const check = await tools.skill_inspect({ path: "/work/out/cs2-news-brief" });
text(await tools.skill_publish({
  path: "/work/out/cs2-news-brief",
  workspaceRevision: check.workspaceRevision,
  expectedRevision: check.expectedRevision,
}));
```

`skill_inspect` 返回结构化结果，可在同一 Code Mode 脚本内直接使用版本字段。发布按工作区版本及 Registry 版本比较，冲突时重新检查，不覆盖未知修改。附件转换为可跨 Durable Object RPC 传输的普通对象，同时保留特殊文件名为自有属性。

主人私聊或管理页发起的任务，在子任务汇报触发的父会话续轮中仍可检查、发布技能。每次操作重新核对原始用户输入、任务授权、身份、回复入口及会话代次；取消任务或重置会话后失效。子 agent 本身没有全局技能发布工具。

发布失败返回可识别的错误码；未知错误包含 `errorId`、失败阶段和异常类型。Worker 日志中的 `workspace_skill_failed` 使用同一 `errorId`，不记录技能正文、附件或可能带凭据的异常文本。

## 网页与订阅源

`web_page` 支持 HTML、纯文本、JSON、RSS、Atom 和 XML。XML 保留原始链接与时间字段；返回 `truncated=true` 时不得认定已读完整。HTTP 失败保留状态码，以及服务器给出的 `retryAfterSeconds`；工具不立即循环重试。

## 采集脚本

`workers/scripts/collect_feed.py` 是无第三方依赖的 Python 采集器，可作为 `collect_feed.py` 附件放入早报技能。固定窗口为 `(start, cutoff]`，只有确实翻过起点才标记该订阅源窗口扫描完成，不代表互联网新闻全量覆盖。HLTV RSS 没有在本脚本中假定存在分页接口，订阅源覆盖不到起点时明确返回缺口。

```sh
python3 collect_feed.py reddit \
  --start '2026-11-09T09:00:00+08:00' \
  --cutoff '2026-11-10T09:00:00+08:00' \
  --out /work/out/news-runs/2026-11-10-reddit.json
```

同一个窗口重跑同一命令会读取已有进度；下一期使用新的输出文件。每成功取得一页即保存条目、时间范围和游标，按 ID 去重。一个任务内由父 agent 负责同一来源的采集，避免父子任务重复抓取；跨工作区的输出不能假定共享。

| 状态 | 含义与后续操作 |
| --- | --- |
| `complete`，退出码 0 | 已扫描到该来源窗口起点；逐条核实正文后才可入报 |
| `waiting`，退出码 75 | 429 或暂时性错误；保存 `retryAt`，到时用相同参数续取，未到时间不会发请求 |
| `partial` 且有 `retryAt`，退出码 75 | 本次页数预算耗尽；等待后从已保存游标继续 |
| `partial`，退出码 2 | 空页、重复页、时间异常或 RSS 范围不足；保留缺口，检查入口和备用证据 |
| `blocked`，退出码 2 | 403 等非暂时性 HTTP 错误；停止该次采集，不更换身份或出口规避限制 |

默认每次最多 5 页、页间间隔 5 秒，可用 `--max-pages` 和 `--interval` 调整。冷却时间优先采用服务端 `Retry-After`，缺省时指数退避。长冷却退出进程，由任务在可执行时续取，避免在云端长时间等待消耗运行时长；等待不应自动变成人工接管需求。返回 403 或持续不可用时保留客观限制，不承诺站点一定恢复。

该脚本不创建定时任务，不发布技能，不发 QQ；自动任务使用哪一版技能仍以 Registry 为准。

## 验证

`npm run check` 包括真实 Registry RPC 发布、QQ/网页父会话续轮、撤销授权、HTTP/RSS 以及三个 Python 采集器行为回归。Python 只用标准库；Windows 可用 `CS_AGENT_TEST_PYTHON` 指向现有 Python 3.9+。

这些测试验证发布与恢复机制，不证明真实站点永久可访问或新闻召回率已改善。发布前还应对同一截止时间的新旧早报做证据对照。
