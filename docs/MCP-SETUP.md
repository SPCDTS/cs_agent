# 动态 MCP 接入

远程 HTTPS Streamable HTTP 服务可在运行时接入，无需为每个服务修改代码或重新部署。连接、分页工具发现、目录缓存、`codemode` 调用、资源读取、OAuth 登录和刷新均复用现有实现。

## 通过 cs-agent 接入

在主人私聊或共享 owner 上下文的管理页会话中，提供服务名称、官方 MCP 地址、认证方式和希望开放的能力。cs-agent 使用 `mcp_manage` 完成登记、检测工具与启用；该工具不会授予群聊、事件或子 agent 管理服务的权限。

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

## 设备命令行与可选桌面

新设备可在“模型与接入 → 添加设备”生成短期配对链接。轻量客户端默认提供本机命令行，agent-desktop 按需安装，自动配置独立 Tunnel 和 MCP 凭据。管理员首次配置、安装和恢复步骤见 [设备 MCP](DEVICE-MCP.md)。

## Windows 远程环境

Hyper-V 持久工作区和临时 WSB 使用同一个标准 MCP 服务接入，安装、Tunnel、Token 与工具选择见 [Windows MCP](WINDOWS-MCP.md)。Cloudflare Container 保留原生 coding，不迁移为 MCP。

Windows runner 的固定 env_* 工具使用环境级授权：管理页群授权中的 environments 是 envId 清单，留空即不开放；environmentApproval 默认为 required，可明确设为 none 允许授权范围内的环境操作直接执行。两字段沿用现有 PUT /admin/mcp/access 和 mcp_access JSON 存储，不新增服务。固定工具名及宿主元数据协议见 [Windows MCP](WINDOWS-MCP.md)。这些名称由平台按环境协议识别；其他普通 MCP 工具继续按原工具权限与逐次审批策略执行。
