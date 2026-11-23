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

管理台的 Token 输入框不回显凭据。凭据使用现有 `OAUTH_STORE_KEY` 加密保存在 Registry；不要更换这把密钥。变更审计复用 owner 会话的 `mcp_management` 事件，只包含服务 ID、操作和来源，不含凭据。

## 共享目录

每个服务占用主人沙箱中的 `/shared/mcp/<服务 ID>/`。管理台与 MCP 连接器使用同一份文件。群会话通过已有的群授权调用具体工具，群沙箱中没有 MCP 连接目录。

| 文件 | 用途 |
| --- | --- |
| `server.json` | 服务 ID、HTTPS 地址、认证方式、启用状态、允许的工具与资源前缀。可先通过管理台创建一条连接，再在主人沙箱编辑。 |
| `headers.json` | Token 认证头的 JSON 对象，例如 `{"Authorization":"Bearer <令牌>"}`。在管理台保存 Token 会更新此文件。 |
| `oauth.json` | OAuth 登录与续期写入的登录态，含 issuer、access_token、refresh_token、scope 和 expires_at（毫秒时间戳或 null）。登出后删除。 |

主人也可以在一次沙箱操作中创建服务目录和 `server.json`。下面是一份可启用的只读工具配置，服务实际提供的工具名需要与 `allow` 一致。

```json
{
  "id": "query",
  "enabled": true,
  "transport": { "kind": "streamable-http", "url": "https://example.com/mcp" },
  "credential": { "kind": "managed", "accountId": "owner-query", "revision": "initial" },
  "access": { "kind": "owner-private" },
  "tools": { "allow": ["lookup"], "readOnly": ["lookup"] },
  "replay": "unsafe"
}
```

写入配置或替换凭据后，宿主生成新的授权版本；需要群使用时，在「权限与运维」重新确认。更换服务地址时，原地址的登录态会被清除，可以在同次操作中明确提供新凭据。正常 OAuth 自动续期保留现有授权。

## API 与存储

以下接口沿用管理页的 `ADMIN_TOKEN` Bearer 校验：

| 接口 | 用途 |
|---|---|
| `GET /admin/mcp/servers` | 读取配置、凭据是否存在和最近检测的工具摘要，不返回凭据值 |
| `POST /admin/mcp/manage` | 传入 `action` 和对应参数，执行与 agent 相同的管理流程 |
| `PUT /admin/mcp/servers/:id/credentials` | 传入 `expectedRevision` 和 `headers`，加密保存认证头 |

服务目录复用 RegistryDO 的 SQLite。升级时，已有服务配置、可解密的 Token 和当前 OAuth 登录态迁入对应文件，管理台保留原有工具选择。旧 `secretHeaders` 引用在部署绑定可用时首次导入，随后连接直接读取目录；缺少旧绑定时可在管理台重新配置。部署密钥 `OAUTH_STORE_KEY` 继续保护静态凭据。新实例从 `workers/mcp.json` 初始化一次，后续部署保留运行时修改。

接纳新输入时同步配置；agent 启用服务后立即刷新目录。调用前核对当前配置，停用、删除或更换服务后，旧会话及已派发子任务不能继续使用旧连接执行新的调用。已经发出的远端操作无法通过停用撤回。无需新增 DO 类型、容器、Cloudflare API 权限或定时任务。

本地 stdio 服务仍需本机程序与 HTTPS 桥接。此接入机制不会自动安装本机软件，也不会修改 CS2 Workshop 项目。

## 设备命令行与可选桌面

新设备可在“模型与接入 → 添加设备与 Cloudflare 管理”生成短期配对链接。轻量客户端默认提供本机命令行，agent-desktop 按需安装，自动配置独立 Tunnel 和 MCP 凭据。管理员首次配置、安装和恢复步骤见 [设备 MCP](DEVICE-MCP.md)。

## Windows 远程环境

持久 Hyper-V VM 在来宾内按[设备配对流程](DEVICE-MCP.md)接入，模型通过 `device_info` 和 `shell_*` 使用它。临时 WSB 使用宿主机的 `env_*` 服务，旧 VM 任务的收尾步骤见 [Windows MCP](WINDOWS-MCP.md)。Cloudflare Container 保留原生 coding，不迁移为 MCP。

Windows runner 的固定 env_* 工具使用环境级授权：管理页群授权中的 environments 是 envId 清单，留空即不开放；environmentApproval 默认为 required，可明确设为 none 允许授权范围内的环境操作直接执行。两字段沿用现有 PUT /admin/mcp/access 和 mcp_access JSON 存储，不新增服务。固定工具名及宿主元数据协议见 [Windows MCP](WINDOWS-MCP.md)。这些名称由平台按环境协议识别；其他普通 MCP 工具继续按原工具权限与逐次审批策略执行。
