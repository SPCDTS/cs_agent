# Pi 外部 MCP 使用说明

Pi 后端可以把外部 MCP 的每个工具注册为 Pi 原生工具，保留参数 schema，并通过现有 ToolTask 保存调用检查点和结果。支持 Streamable HTTP、静态凭据与 OAuth 授权码 + PKCE；不支持 stdio。

## 启用

1. 从 [配置示例](design/pi-mcp/config.example.json) 复制管理员配置，只保留需要的服务，替换 HTTP 地址，并填写远端工具原名的 `tools.allow`。
2. 将配置放到管理员维护的位置，设置 `PI_MCP_CONFIG` 为该 JSON 文件的绝对路径。文件必须是 UTF-8，支持 BOM。不要把密钥写入配置。
3. 确认目标会话使用 Pi 后端：设置 `AGENT_BACKEND=pi`，或在后端覆盖设置中将 owner 私聊 / 指定群分配给 Pi。
4. 将配置引用的秘密环境变量注入 cs-agent 进程，重启服务。修改 MCP 配置、账号或凭据后需要重启；更换账号、token 或权限时同时递增 `credential.revision`。

Compose 部署时，配置文件必须通过只读挂载进入 cs-agent 容器，`PI_MCP_CONFIG` 填写容器内路径。默认 `.env` 会注入容器，但不会自动挂载任意宿主文件。

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

`DOCS_AUTH_HEADER` 的值是完整请求头，例如 `Bearer <token>`。无认证服务使用 `credential: { "kind": "none" }`，去掉 `secretHeaders`。HTTP 默认要求 HTTPS；本地开发服务需显式设置 `allowLoopbackHttp: true` 才接受回环 HTTP。传输请求不跟随重定向；OAuth 的浏览器跳转仅由面板登录发起。不回退到旧 SSE transport，也不自动恢复 SSE 断点。

局域网服务使用 HTTP 时，管理员可为该服务设置 `transport.allowPrivateNetworkHttp: true`，仅放行 RFC1918 私网 IPv4 字面地址（`10/8`、`172.16/12`、`192.168/16`）。该开关不放开公网、链路本地地址或域名；请求仍只发往配置的固定来源，不跟随重定向。

## OAuth 登录（CIMD）

在 `servers` 中加入以下服务；`tools.allow` 是示例名，请按远端实际工具精确填写：

```json
{
  "id": "notion",
  "enabled": true,
  "transport": {
    "kind": "streamable-http",
    "url": "https://mcp.notion.com/mcp"
  },
  "credential": {
    "kind": "oauth",
    "accountId": "owner-notion",
    "revision": "1",
    "clientMetadataUrl": "https://jule-agent.vercel.app/oauth/client-metadata.json",
    "registration": "cimd",
    "scope": "default"
  },
  "tools": {
    "allow": [
      "notion-search"
    ]
  },
  "access": {
    "kind": "owner-private"
  },
  "replay": "unsafe"
}
```

`registration` 默认 `cimd`，此时 `clientMetadataUrl` 必须是非根路径的 HTTPS URL。服务不支持 CIMD 时不会自动动态注册；显式改为 `registration: "dynamic"` 才启用 DCR，且不向 SDK 传递 `clientMetadataUrl`。OAuth 服务不能在 `headers` 或 `secretHeaders` 中设置任何大小写的 `Authorization`。

`PI_MCP_OAUTH_REDIRECT_URL` 默认 `http://127.0.0.1:8787/mcp/oauth/callback`；只接受不含 query/hash 的 HTTP(S) 绝对 URL，且必须与公开 CIMD 文档的 `redirect_uris` 逐字一致。更换回调地址需同步更新公开元数据。

操作路径是：先进入面板，再打开 `/mcp/accounts` → 点击服务的「登录」→ 在外部服务的浏览器授权页确认 → 回调显示「外部账号已登录」的同站 HTML，点击「返回外部账号」链接进入账号页。账号页（面板顶栏「外部账号」）列出各服务的登录状态、到期时间与最近错误，并提供登录、重新登录与退出。接口与表单约定见 [面板文档](DASHBOARD.md#11-外部账号接口)。登录入口只在面板，不在聊天或模型工具中提供。

凭据保存到 `DATA_DIR/mcp-oauth.sqlite`，与账号的 `serverId + accountId + revision` 绑定。修改 `revision` 等于换账号版本，重启后需要重新登录，不使用旧版本 token。运行回合没有 token 时在联网前返回 `auth_required`；运行时不安装 SDK authProvider，传输层在每次请求前注入 Bearer。临近过期（60 秒）时在账号锁内刷新；资源 401 同样在锁内复核 token 版本，其他连接已刷新则复用新 token，否则刷新，并对同一请求只重试一次（含 POST、SSE GET 与 DELETE）。重试仍为 401 时返回 auth_required，SDK 不会收到 401；403 仍拒绝。只有授权服务器返回确定的 OAuth 错误（如 invalid_grant、invalid_client、unauthorized_client）才删除 token 并保留 refresh_failed，需 owner 重新登录；网络错误、超时、5xx 与暂态服务错误只使本次请求以 transport_error 失败，不改 token 或状态，下次请求仍可刷新。

OAuth 发现、换码、注册、刷新与撤销请求仅允许资源 origin 和 issuer origin：登录先仅从资源 origin 获取 PRM，再加入其中所选 issuer 的 origin；刷新与撤销使用已保存 token 的 issuer。授权页 URL 必须属于 issuer origin。请求不跟随重定向，DNS 全部地址校验后固定交给 socket，让 Node 在地址族间回落，不再次解析。

退出登录会尽力撤销 refresh token，再删除本地 token 与状态；CIMD 客户端身份可以保留。库及 WAL 属于私密凭据，不加入 datasette；已有沙箱 `*.sqlite*` 禁读规则覆盖它。

## 权限与结果

owner 私聊主会话及 `access.groups` 指定的群可以使用 MCP，普通私聊与未配置的群拒绝。执行前及排队后按 `runRights` 复核真实身份。定时和唤醒默认关闭；可分别设置 `access.allowScheduled`、`access.allowWake`，继承定时身份的唤醒需要两个选项都开启。群内也按回合代表的人授权：owner 直接执行，成员适用审批；只有基础权限、无法确证人的回合拒绝。

### 群内使用与审批

群使用 Pi 后端，且必须在 `QQ_ALLOW_GROUPS` 与服务的 `access.groups` 中。群消息仍需真实 @机器人（`QQ_GROUP_MENTIONS`）；引用审批消息时也要 @，文本写“@昵称”无效。

`access.groups`、`tools.approval` 默认均为 `[]`；`approval` 必须是 `allow` 的子集，名称使用远端原名。cs2-workshop 的服务配置可使用：

```json
{
"tools": {
  "allow": ["workshop_browse", "workshop_context", "workshop_status", "workshop_results", "workshop_prepare", "workshop_edit", "workshop_mode", "workshop_trial", "workshop_produce"],
  "approval": ["workshop_prepare", "workshop_edit", "workshop_mode", "workshop_trial", "workshop_produce"]
},
"access": { "kind": "owner-private", "groups": ["123456"] }
}
```

- owner 在允许群中可直接调用全部白名单工具；其他成员可直接调用 `allow` 中不在 `approval` 的工具。
- 成员调用审批工具时只登记已校验的调用，群里 @首个 owner，模型拿到四位编号。每群最多 5 条、每人最多 3 条待审批，有效期 30 分钟；同一会话的同一 call_id 重放返回原编号。
- owner 引用通知回复“批准 / 同意 / 通过 / 允许 / 可以”或“拒绝 / 驳回 / 不行 / 不允许”，也可发“批准 #A7K2”“拒绝 #A7K2”。裸命令要求补引用或编号。宿主消费这些输入，不交给模型；非 owner 的同样文字仍是普通聊天。
- 批准后系统执行保存的原参数，在群里引用 owner 的决定并 @申请人报告结果。通知发送失败仍保留请求，可按编号审批。执行时配置摘要、群、白名单、审批名单或 owner 身份不再匹配，则拒绝执行。
- 执行前持久提交 `executing`；重启后改为 `unknown` 并通知先用 `workshop_status` 核对，绝不自动重试。系统消息进入普通消息库，后续回合可通过“期间消息”看到。

外部账号始终属于 owner；连接按 Pi 会话隔离，群与私聊、子会话互不共用。允许群内 owner 与成员共用一份工具目录（群独立权限范围，审批工具带审批说明），工具名不随回合身份变化，是否审批在执行时按身份决定；审批回执不套用远端输出 schema，真正执行仍校验远端结果。群内有权的人也可使用 `mcp_refresh_tools`。

### 子 agent 与工具结果

子 agent 在服务的 `access.allowSubagent: true` 开启时继承派出时的授权快照；该布尔选项默认 `false`。父回合必须已获该服务授权：私聊仅限 owner，允许群内可由 owner 或成员派出，不能仅凭父工具列表获得账号权限。子 agent 保留派出者身份与权限；成员派出的读工具直接执行，审批工具走同一主人审批入口。快照与子会话在同一次 Pi 提交中保存，包含派出者身份、派出回合的定时/唤醒限制和服务配置摘要（固定账号、凭据版本及工具白名单）。配置改变后已有子任务不会自动获得新能力，需要重新派出。

每次 spawn/message 投递前及重启恢复调度前，用子会话自己的 ID 重配 MCP 工具与连接；请求前 hook 从已经持久化的模型请求中移除失效工具，新名称在下一次准备模型请求时提供。message 只收紧快照，不增加服务或重新授权；不同人续发会撤掉 MCP，之后 owner 续发也不会恢复。父回合有 MCP 而 spawn 未获委派，或 message 刚撤掉已有委派时，工具结果会提示主 agent 自行调用 MCP。执行时取“派出快照 ∩ 当前有效授权 ∩ 子任务范围”：派出者身份失效、服务在当前配置中禁用或 `allowSubagent` 关闭，后续调用立即拒绝。配置文件仍在启动时读取，修改磁盘文件须重启后生效。

目录完整分页读取，再按白名单选择工具。不支持的 schema 隔离到单个工具，不放宽条件。当前支持严格 draft-07 子集、根 object 和非循环本地 `$ref`；不支持 `$defs`、`$id`、外部引用或未知 format/关键字。详细支持范围见 [schema.ts](../src/agent/pi-mcp/schema.ts) 和边界测试。

工具名称形如 `mcp_docs_search_<hash>`。名称按单工具身份计算：只有服务器配置、权限范围或该工具的输入/输出契约变化才改变名称。其他工具及纯描述变化不影响名称；schema 节点的 `description`、`title`、`$comment` 不参与身份计算，同名业务属性和常量数据保留。更新描述后下一次模型请求可见新文字。

旧定义继续留在 `pi.sqlite`。执行前核对当前目标工具的契约与实际权限，不能靠旧名称恢复已撤销权限。模型调用历史旧名称时得到 `tool_unavailable` 或 `tool_retired` 失败结果，本次调用未发送；当前工具已在模型的工具列表中，也可调用 `mcp_refresh_tools` 刷新。不自动转换参数，也不改变此前操作的未知结果。

连接或重连会重新发现目录，另有默认五分钟 TTL。支持 `list_changed` 的服务会在工具轮结束或下次调用前刷新；没有通知能力的静态服务仍可使用。owner 私聊、允许群内有权的人及已获委派的子 agent 可调用 `mcp_refresh_tools` 显式刷新当前授权范围（子 agent 仅限快照内服务）；它只读取目录，不调用远端业务工具。现有 IM、定时和本地工具选择会保留。

文本、图片和结构化数据均有大小限制。图片验证 base64、格式头、声明尺寸及字节限额，不做完整像素解码；资源与音频等内容给出省略说明，不自动下载。工具参数和有界结果进入 Pi 正常历史；MCP 审计只记录身份、目录摘要、调用标识、耗时、大小与错误码，不记录正文或凭据。

## 中断、关闭与容量

所有外部工具固定 `replay: "unsafe"`。网络超时或断线发生在发送后时，返回 `outcome_unknown`；进程崩溃时，已有 execute 检查点按 Pi 的 `interrupted` 结算。已提交结果恢复后直接复用。任何这些情况都不会自动重发原工具调用，但也不能据此断定远端未执行，后续操作应先核对外部状态。

连接按会话、真实账号身份和服务配置隔离；每条连接串行，等待队列、活跃连接及关闭连接受限。默认总调用预算 60 秒、初始化 10 秒、最多 16 条连接、每条连接最多 16 个等待项，闲置五分钟回收。配置缺失、无效或服务离线不会阻塞整个 Pi 启动。

目录默认最多保留 128 个版本、合计 32 MiB。启动时、以及发布新版本将超限时回收旧版本：只保留仍被会话工具选择、非终态工具任务或当前连接引用的版本，只改描述的版本合并为一个。任何引用无法确认时整轮不删。回收后仍超限才拒绝发布并降级服务。限制在配置的 `limits` 中调整，有硬上限；不要靠删除整个 `pi.sqlite` 清理目录，那会丢失 Pi 会话与调用记录。

## 排查与验证

| 现象或审计码 | 检查方向 |
| --- | --- |
| 配置 invalid / 工具未出现 | JSON 字段、实际后端、owner 私聊身份、精确白名单 |
| `auth_required` | 在面板登录外部账号；核对 accountId/revision、回调地址与 CIMD 文档一致性 |
| `refresh_failed` | 授权服务器返回确定的 OAuth 错误，token 已删除；在面板重新登录。网络错误、超时与 5xx 不会产生此状态 |
| `missing_secret` / `auth_failed` | 引用变量是否注入、请求头完整值、外部账号权限 |
| `tool_unavailable` / `tool_retired` | 历史名称、目标工具契约或账号配置已变，改用工具列表中的当前工具；必要时调用 `mcp_refresh_tools` |
| `catalog_storage_limit` | 回收后仍超出目录容量：仍被引用的版本过多。核对限额与频繁变化的远端 schema；trace 中 `mcp_catalog` 的 `pruned` 记录回收数量，`prune_*` 降级码表示本轮未回收 |
| `connections_busy` / `queue_busy` | 并发量或长时间调用占满额度 |
| `outcome_unknown` / `interrupted` | 先查远端是否已执行；不会自动重试原操作 |
| `remote_state_lost` | 原 HTTP 会话消失，浏览器页面等远端状态需要重建；发送后的调用仍算未知结果 |

运行验证：

```text
npm run typecheck
npm test
npm run test:integration -- test/agent/pi-mcp-recovery.test.ts
```

测试使用本机 HTTP 桩和 Pi SQLite；崩溃测试真正杀死持有 SQLite 的调用进程，再打开相同数据库，由父进程中的 HTTP 桩计数验证未重发。这些验证不依赖生产账号；接入具体服务后仍需针对它的 schema、凭据和运行环境做部署验证。

完整架构与后续范围见 [设计文档](PI-MCP-DESIGN.md)。
