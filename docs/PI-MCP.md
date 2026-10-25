# Pi 外部 MCP 使用说明

Pi 后端可以把外部 MCP 的每个工具注册为 Pi 原生工具，保留参数 schema，并通过现有 ToolTask 保存调用检查点和结果。支持 stdio 与 Streamable HTTP、静态凭据，不支持 OAuth。

## 启用

1. 从 [配置示例](design/pi-mcp/config.example.json) 复制管理员配置，只保留需要的服务，替换绝对程序路径或 HTTP 地址，并填写远端工具原名的 `tools.allow`。
2. 将配置放到管理员维护的位置，设置 `PI_MCP_CONFIG` 为该 JSON 文件的绝对路径。文件必须是 UTF-8，支持 BOM。不要把密钥写入配置。
3. 确认 owner 私聊使用 Pi 后端：设置 `AGENT_BACKEND=pi`，或在现有后端覆盖设置中将 owner 私聊分配给 Pi。
4. 将配置引用的秘密环境变量注入 cs-agent 进程，重启服务。修改 MCP 配置、账号或凭据后需要重启；更换账号、token 或权限时同时递增 `credential.revision`。

Compose 部署时，配置文件必须通过只读挂载进入 cs-agent 容器，`PI_MCP_CONFIG`、stdio 的 `command` 和固定 `cwd` 均填写容器内路径。默认 `.env` 会注入容器，但不会自动挂载任意宿主文件；宿主 Windows 可执行文件也不能直接作为 Linux 容器中的 stdio 命令。

最小 HTTP 示例：

```json
{
  "version": 1,
  "enabled": true,
  "servers": [{
    "id": "docs",
    "transport": {
      "kind": "streamable-http",
      "url": "https://mcp.example.com/mcp",
      "secretHeaders": { "Authorization": "DOCS_AUTH_HEADER" }
    },
    "credential": { "kind": "external-account", "accountId": "owner-docs", "revision": "1" },
    "tools": { "allow": ["search", "fetch_document"] },
    "access": { "kind": "owner-private" },
    "replay": "unsafe"
  }]
}
```

`DOCS_AUTH_HEADER` 的值是完整请求头，例如 `Bearer <token>`。无认证服务使用 `credential: { "kind": "none" }`，去掉 `secretHeaders`。HTTP 默认要求 HTTPS；本地开发服务需显式设置 `allowLoopbackHttp: true` 才接受回环 HTTP。所有重定向都拒绝，不启动 OAuth，不回退到旧 SSE transport，也不自动恢复 SSE 断点。

局域网服务使用 HTTP 时，管理员可为该服务设置 `transport.allowPrivateNetworkHttp: true`，仅放行 RFC1918 私网 IPv4 字面地址（`10/8`、`172.16/12`、`192.168/16`）。该开关不放开公网、链路本地地址或域名；请求仍只发往配置的固定来源，不跟随重定向。

## stdio 与运行环境

stdio 的 `command` 必须是绝对可执行路径，`args` 是参数数组，不经过 shell，也不自动安装包。`cwd` 和整个参数可以使用 `${sessionWorkspace}`，其值由宿主为当前会话提供。其他模板形式会被拒绝。

只继承 `inheritEnv` 中列出的环境变量；普通值写到 `env`，秘密用 `secretEnv` 将子进程变量名映射到宿主环境变量名。不要把秘密放进 `args`、URL 或普通配置字段。Windows 的 Node MCP 通常需要显式继承 `SystemRoot`；按程序需要增加 `TEMP`、`TMP` 或 `PATH`。

Windows 使用 Windows PowerShell 的静态辅助脚本与 Job Object，要求 `Add-Type` 可用；Linux 使用独立进程组。两者都会在正常关闭、初始化失败及直接子进程先退出时回收后代进程。

`execution: "trusted-host"` 表示按 cs-agent 的 OS 用户权限运行。工作目录和 `--root` 不是操作系统沙箱，Pi bash 的 bwrap 配置也不覆盖 MCP。需要更强隔离时，管理员应提供隔离后的可执行入口。

## 权限与结果

首版仅给 owner 私聊主会话选择工具，普通用户、群聊和子 agent 均拒绝。执行前再次读取真实回合身份，排队后继续复核当前 owner。定时和唤醒默认关闭；可分别设置 `access.allowScheduled`、`access.allowWake`，继承定时身份的唤醒需要两个选项都开启。

目录完整分页读取，再按白名单选择工具。不支持的 schema 隔离到单个工具，不放宽条件。当前支持严格 draft-07 子集、根 object 和非循环本地 `$ref`；不支持 `$defs`、`$id`、外部引用或未知 format/关键字。详细支持范围见 [schema.ts](../src/agent/pi-mcp/schema.ts) 和边界测试。

工具名称形如 `mcp_docs_search_<hash>`。新目录使用 v2 单工具身份：只有服务器配置、权限范围或该工具的输入/输出契约变化才改变名称。其他工具及纯描述变化不影响名称；schema 节点的 `description`、`title`、`$comment` 不参与身份计算，同名业务属性和常量数据保留。更新描述后下一次模型请求可见新文字。

旧定义继续留在 `pi.sqlite`，v1 历史目录按原算法恢复。执行前核对当前目标工具的契约与实际权限，不能靠旧名称恢复已撤销权限。模型调用历史旧名称时，会在后续请求中得到当前工具指引；提示只针对结构化诊断确认尚未派发的本次调用，不改写原日志、不自动转换参数，也不改变此前操作的未知结果。

连接或重连会重新发现目录，另有默认五分钟 TTL。支持 `list_changed` 的服务会在工具轮结束或下次调用前刷新；没有通知能力的静态服务仍可使用。owner 私聊可调用 `mcp_refresh_tools` 显式刷新当前授权范围；它只读取目录，不调用远端业务工具。现有 IM、定时和本地工具选择会保留。

文本、图片和结构化数据均有大小限制。图片验证 base64、格式头、声明尺寸及字节限额，不做完整像素解码；资源与音频等内容给出省略说明，不自动下载。工具参数和有界结果进入 Pi 正常历史；MCP 审计只记录身份、目录摘要、调用标识、耗时、大小与错误码，不记录正文或凭据。

## 中断、关闭与容量

所有外部工具固定 `replay: "unsafe"`。网络超时或断线发生在发送后时，返回 `outcome_unknown`；进程崩溃时，已有 execute 检查点按 Pi 的 `interrupted` 结算。已提交结果恢复后直接复用。任何这些情况都不会自动重发原工具调用，但也不能据此断定远端未执行，后续操作应先核对外部状态。

连接按会话、真实账号身份、服务配置和工作目录隔离；每条连接串行，等待队列、活跃连接及关闭连接受限。默认总调用预算 60 秒、初始化 10 秒、最多 16 条连接、每条连接最多 16 个等待项，闲置五分钟回收。配置缺失、无效或服务离线不会阻塞整个 Pi 启动。

目录默认最多保留 128 个版本、合计 32 MiB。启动时、以及发布新版本将超限时回收旧版本：只保留仍被会话工具选择、非终态工具任务或当前连接引用的版本，只改描述的版本合并为一个。任何引用无法确认时整轮不删。回收后仍超限才拒绝发布并降级服务。限制在配置的 `limits` 中调整，有硬上限；不要靠删除整个 `pi.sqlite` 清理目录，那会丢失 Pi 会话与调用记录。

## 排查与验证

| 现象或审计码 | 检查方向 |
| --- | --- |
| 配置 invalid / 工具未出现 | JSON 字段、实际后端、owner 私聊身份、精确白名单 |
| `missing_secret` / `auth_failed` | 引用变量是否注入、请求头完整值、外部账号权限 |
| `tool_unavailable` / `tool_retired` | 历史名称、目标工具契约或账号配置已变，按迁移提示使用当前工具；必要时调用 `mcp_refresh_tools` |
| `catalog_storage_limit` | 回收后仍超出目录容量：仍被引用的版本过多。核对限额与频繁变化的远端 schema；trace 中 `mcp_catalog` 的 `pruned` 记录回收数量，`prune_*` 降级码表示本轮未回收 |
| `connections_busy` / `queue_busy` | 并发量或长时间调用占满额度 |
| `outcome_unknown` / `interrupted` | 先查远端是否已执行；不会自动重试原操作 |
| `remote_state_lost` | 原 HTTP 会话消失，浏览器页面等远端状态需要重建；发送后的调用仍算未知结果 |

运行验证：

```text
npm run typecheck
npm test
npm run test:integration -- test/agent/pi-mcp-stdio.test.ts test/agent/pi-mcp-recovery.test.ts
```

测试使用本机 HTTP 桩、真实 stdio 子进程和 Pi SQLite；崩溃测试真正杀死调用进程，再打开相同数据库验证未重发。Linux 进程树的独立无网络容器冒烟脚本为 `test/agent/fixtures/pi-mcp-linux-smoke.mjs`。这些验证不依赖生产账号；接入具体服务后仍需针对它的 schema、凭据和运行环境做部署验证。

完整架构与后续范围见 [设计文档](PI-MCP-DESIGN.md)。
