# 动态 MCP 接入

远程 HTTPS Streamable HTTP 服务可在运行时接入，无需为每个服务修改代码或重新部署。连接、分页工具发现、目录缓存、`codemode` 调用、资源读取、OAuth 登录和刷新均复用现有实现。

## 通过 Joule 接入

在主人私聊或共享 owner 上下文的管理页会话中，提供服务名称、官方 MCP 地址、认证方式和希望开放的能力。Joule 使用 `mcp_manage` 完成登记、检测工具与启用；该工具不会授予群聊、事件或子 agent 管理服务的权限。

1. `list` / `get` 查看配置与当前 `revision`。
2. `put` 登记连接。新服务的 `expectedRevision` 为 `absent`，默认停用；已有服务修改须携带当前版本。
3. 无认证服务直接检测；Token 服务给出管理页入口，主人在页面填写凭据；OAuth 服务用 `login` 获取现有一次性授权链接。
4. 完成凭据填写或登录后，回到对话告知完成。agent 重新 `get`、`probe`，选择发现的工具并 `activate`，随后在当前会话使用。
5. 后续调用继续使用 `codemode` 下的远端工具、`mcp_refresh_tools` 和 `mcp_resources_*`。管理工具只负责接入配置。

模型工具的参数外层是 `request`，例如 `mcp_manage({request:{action:"list"}})`。服务描述、工具描述和 `readOnlyHint` 都是远端资料；只读清单由主人意图与工具实际用途决定，不能直接信任服务声明。无法确认时不标记为只读。

工具定义兼容 GitHub 的 `x-mcp-header` 元数据；当前 SDK 协议下不需要生成对应 HTTP 参数头，该元数据不会进入模型参数校验，也不会被当作授权。启用时若仍有不支持的定义，agent 与管理 API 会收到 `tools_rejected`、被拒工具名和原因，管理页也会显示明细。失败保留原有配置与凭据，调整工具选择后即可重试。

当前 OAuth 支持沿用 CIMD + PKCE。要求预注册 OAuth App 或其他授权机制的服务需额外适配，也可使用服务支持的 Token。登录完成不会自动发起新的模型回合；用户返回对话后继续接入。

## 管理页

“模型与接入 → MCP 服务 → 接入或管理 MCP 服务”可手动完成相同流程。页面只在进入该页时加载服务，不新增后台轮询。

- 保存名称、HTTPS 地址及认证方式。
- Token 选项可填写认证头名称和值；`Authorization` 可直接填 Token，页面补上 `Bearer`。服务要求其他认证头时填写对应名称和完整值。API 支持多个认证头。
- 凭据保存后自动检测；检测成功后勾选需要的工具，核实只读分类，按需填写允许读取的资源 URI 前缀，再启用。
- 重新保存已有连接会清除旧凭据、工具选择和检测结果。只换 Token 时使用“保存凭据并检测”。
- 停用保留配置及凭据；移除删除配置和该服务的 OAuth 登录数据。更换连接或凭据后，已有群授权失效，需在“权限与运维”重新确认。

Token 不通过聊天或模型工具参数接收，不回显。凭据使用现有 `OAUTH_STORE_KEY` 加密保存在 Registry；不要更换这把密钥。变更审计复用 owner 会话的 `mcp_management` 事件，只包含服务 ID、操作和来源，不含凭据。

## API 与存储

以下接口沿用管理页的 `ADMIN_TOKEN` Bearer 校验：

| 接口 | 用途 |
|---|---|
| `GET /admin/mcp/servers` | 读取配置、凭据是否存在和最近检测的工具摘要，不返回凭据值 |
| `POST /admin/mcp/manage` | 传入 `action` 和对应参数，执行与 agent 相同的管理流程 |
| `PUT /admin/mcp/servers/:id/credentials` | 传入 `expectedRevision` 和 `headers`，加密保存认证头 |

服务存储复用 RegistryDO。首次启动将 `workers/mcp.json` 导入；公开默认模板的服务目录为空，由管理页或 agent 完成接入。升级已有实例保留 Registry 中的 Notion OAuth 凭据、Workshop secret 引用及工具策略。此后以 Registry 数据为准；部署、DO 重启和静态配置变更不会覆盖运行时修改，也不会重新添加已移除的服务。原文件仍提供初始数据和全局 MCP 限额。

接纳新输入时同步配置；agent 启用服务后立即刷新目录。调用前核对当前配置，停用、删除或更换服务后，旧会话及已派发子任务不能继续使用旧连接执行新的调用。已经发出的远端操作无法通过停用撤回。无需新增 DO 类型、容器、Cloudflare API 权限或定时任务。

本地 stdio 服务仍需本机程序与 HTTPS 桥接。此接入机制不会自动安装本机软件，也不会修改 CS2 Workshop 项目。

## 个人设备与 Windows Sandbox

个人设备和持久 VM 共用 `cua`。设备卡默认显示主机名，管理台支持自定义显示名。模型用 `list_spaces` 选择获准设备，再用 `list_tools(service=driver)` 查询该卡的 Driver 工具与参数契约。为目标设备启用对应工具后，获授权的交互会话和子任务可直接调用通用 `space_bash`（短命令）、`space_job`（Linux/macOS 后台长任务）、`space_write`（设备内写文本文件）和完整 `call_tool(service=driver)`（桌面操作与截图），写操作经持久防重放回执保护、无需逐次人工弹窗。设备分配、桥安全边界与隔离验证见 [Cua 设备接入](DEVICE-MCP.md)。

Cloudflare 容器提供会话私有的编码工作区。临时 Windows Sandbox 单独登记为提供 `env_*` 的宿主机服务。[WSB 配置](WINDOWS-MCP.md)

Windows runner 的固定 env_* 工具使用环境级授权：管理页群授权中的 environments 是 envId 清单，留空即不开放；environmentApproval 默认为 required，可明确设为 none 允许授权范围内的环境操作直接执行。两字段沿用现有 PUT /admin/mcp/access 和 mcp_access JSON 存储，不新增服务。固定工具名及宿主元数据协议见 [Windows MCP](WINDOWS-MCP.md)。这些名称由平台按环境协议识别；其他普通 MCP 工具继续按原工具权限与逐次审批策略执行。

## 不开放入站端口的节点：反向 WebSocket

在管理页选择「反向 WebSocket」，或通过 `put` 提交 `server: {"id":"phone","transport":"reverse-websocket"}`。不用提供公网 MCP 地址，也不创建 Cloudflare Tunnel。在管理页为此实例设置独立的 `Authorization` Bearer 凭据（由密码管理器生成至少 32 个随机 URL-safe 字符）；绝不要使用管理员 Token 或在聊天中传递凭据。

节点使用支持自定义请求头的 WebSocket 客户端，主动连接 `wss://<Joule 主机>/mcp/reverse/phone`，握手携带 `Authorization: Bearer <专用凭据>`。HTTP 101 表示注册成功；401 表示未获授权。只接受请求头，不支持 URL 参数或普通浏览器页面的原生 WebSocket 构造器。连接后执行原有的 `probe → activate` 并选择允许工具；节点不能自行启用工具或授予会话权限。

**节点与 SDK 的接线约定**：这是自定义 MCP 传输，不是 Streamable HTTP。每个 UTF-8 文本帧含一个会话信封，每个实例最多接纳 16 个逻辑会话。单条消息限 12 MiB，信封另有 4 KiB 预算。超过 1 MiB 的设备返回使用紧凑 JSON，并按 `session`、`message` 的顺序编码。

- 收到 `{"session":"<uuid>","message":{...}}`：按 UUID 取得独立的 MCP Server 会话；首次 `initialize` 时创建。将 `message` 原样送交该会话的 SDK transport。响应或通知用相同 UUID 和相同信封格式发回；不同会话的 JSON-RPC id 可以重复，不要串用。
- 任一端发送 `{"session":"<uuid>","close":true}` 即可释放该逻辑会话。物理连接关闭时释放全部会话。再次连入会替换同一实例原连接；不要缓存或重发旧调用。节点不在线时探测返回 `reverse_offline`；已发出的写操作失去应答时，沿用 `outcome_unknown`，先核实结果。
- 更换注册凭据会停用服务、清空已发现目录并隔离旧连接；用新凭据重连后重新探测及启用。普通 HTTPS 和 OAuth 服务沿用各自配置。
- 注册节点可发送文本帧 `ping`，平台自动回复 `pong`。管理台显示的在线状态仅代表注册连接。

可参考 `workers/test/mcp-reverse.test.ts` 中用标准 SDK Server 处理会话的可运行例子。

**独立节点试用**：仓库自带仅返回固定问候的 Node 示例，无 shell 或文件权限。安装仓库依赖后，在节点环境安全注入 `REVERSE_MCP_URL`（完整 wss 注册地址）和 `REVERSE_MCP_TOKEN`（不含 Bearer 前缀，不要写进版本库或命令历史），运行 `node runner/scripts/reverse-mcp-example.ts`。保持进程开启，在管理页检测并启用 `hello`。断线后可重新启动示例；示例不自动重试。
