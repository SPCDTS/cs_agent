# Gmail sidecar

Gmail sidecar 是独立的 Streamable HTTP MCP server。在 Google 面前，它使用 Jule 应用的桌面 OAuth 客户端身份，访问 owner 授权的邮箱；在 cs-agent 面前，它是固定 Bearer 鉴权的普通外部 MCP 服务。Pi 通过 HTTP 连接，不直接读取 Google 凭据，也不在 Pi 的 OAuth 面板完成 Gmail 登录。

## 文件与目录

| 宿主机 | 容器内 | 用途 |
| --- | --- | --- |
| `secrets/gmail/client.json` | `/secrets/gmail/client.json`（只读覆盖挂载） | Google 下载的桌面应用客户端 JSON |
| `secrets/gmail/token.json` | `/secrets/gmail/token.json` | refresh/access token、到期毫秒数、scope、首次取得时间；授权与刷新均临时文件 + rename，权限 0600 |
| `data/gmail-sidecar/` | `/state` | `sent.json` 保存 key → messageId、threadId、at，保留 7 天，不含凭据 |

`secrets/` 被 Git 与 Docker 构建上下文忽略，不能移入 `data/`：cs-agent 与 datasette 已挂载 data。sidecar 使用 `node` 用户，Linux 宿主需让 UID 1000 可读客户端文件、可写 token 所在目录及状态目录；Windows 还须用文件 ACL 限制其他用户访问，0600 不能代替 Windows ACL。

## 首次授权

1. 确认 Google Cloud 已启用 Gmail API、OAuth 同意屏幕与桌面应用客户端，将下载的 JSON 放在 `secrets/gmail/client.json`。不要把内容粘贴到聊天或日志。
2. 在宿主仓库运行（Windows PowerShell 用 `npm.cmd run gmail:login`）：

   ```text
   npm run gmail:login
   ```

3. 复制终端打印的授权 URL 到浏览器，选择 owner 的 Gmail。应用未验证时，由 owner 核对应用身份后手动点「高级 → 继续」。只请求 `gmail.readonly` 与 `gmail.send`，固定 `access_type=offline`、`prompt=consent`、`include_granted_scopes=false`，采用 PKCE S256 与随机 state。
4. 回调在 `127.0.0.1` 随机端口监听，Google redirect URI 为 `http://localhost:<port>`。页面显示「授权完成，可关闭」后 CLI 退出 0；十分钟未完成则退出 1。不要在共享终端记录或转发回调 URL。

CLI 默认使用相对路径 `secrets/gmail/client.json` 和 `secrets/gmail/token.json`，可用 `GMAIL_CLIENT_FILE`、`GMAIL_TOKEN_FILE` 覆盖。没有 refresh token 会明确提示使用 `prompt=consent` 重试。授权 URL 不含 client secret、token 或授权码；CLI 不自动打开浏览器。

## Compose 部署

1. Gmail sidecar 属于可选的 `gmail` profile，默认不启动。在管理员维护的 `.env` 设置 `COMPOSE_PROFILES=gmail` 后，普通 `docker compose up -d` 就会包含它；也可以不设置该变量，改用 `docker compose --profile gmail up -d`。启用时配置 `GMAIL_SIDECAR_TOKEN`（至少 32 字符的无空白 ASCII 随机串），并将 `GMAIL_SIDECAR_AUTH_HEADER` 设为 `Bearer <同一个串>`。前者给 sidecar，后者由 Pi MCP 的 `secretHeaders` 引用。示例文件不含实际密钥；sidecar 启动时拒绝缺失或无效的 token，未配置 Gmail 不影响其他服务的 Compose 解析、构建与启动。
2. 首次授权后，准备可写的 `data/gmail-sidecar/` 目录及上述权限。先构建主服务，sidecar 只引用同一镜像，避免重复构建：

   ```text
   docker compose build cs-agent
   docker compose --profile gmail up -d
   docker compose exec gmail-sidecar node -e "fetch('http://127.0.0.1:3731/healthz').then(r=>r.json()).then(console.log)"
   ```

3. `gmail-sidecar` 不发布宿主端口，在 `internal` 网络使用 `172.28.0.10`；cs-agent 同时加入 `default` 和 `internal`，NapCat 仍只在 default。`internal` 是网络名称，没有设置 Docker 的 `internal: true`，因为 sidecar 需要访问 Google。若宿主/VPN 已占用 `172.28.0.0/24`，管理员须一起修改网段、固定 IP 和 Pi 配置。
4. 将下一节的 JSON 放到管理员维护的配置文件，以只读 volume 挂入 cs-agent，并把 `PI_MCP_CONFIG` 设为容器内绝对路径。按 [PI-MCP.md](PI-MCP.md) 切换 owner 私聊到 Pi 后端，重启 cs-agent。

运行时变量：

| 变量 | 默认值 |
| --- | --- |
| `GMAIL_SIDECAR_TOKEN` | 必填，至少 32 字符 |
| `GMAIL_SIDECAR_HOST` / `GMAIL_SIDECAR_PORT` | `0.0.0.0` / `3731` |
| `GMAIL_CLIENT_FILE` / `GMAIL_TOKEN_FILE` | `/secrets/gmail/client.json` / `/secrets/gmail/token.json` |
| `GMAIL_STATE_DIR` | `/state` |

## Pi MCP 配置

```json
{
  "version": 1,
  "enabled": true,
  "servers": [{
    "id": "gmail",
    "transport": {
      "kind": "streamable-http",
      "url": "http://172.28.0.10:3731/mcp",
      "allowPrivateNetworkHttp": true,
      "secretHeaders": { "Authorization": "GMAIL_SIDECAR_AUTH_HEADER" }
    },
    "credential": { "kind": "external-account", "accountId": "owner-gmail", "revision": "1" },
    "tools": { "allow": ["gmail_search", "gmail_read", "gmail_send"] },
    "access": { "kind": "owner-private" },
    "replay": "unsafe"
  }]
}
```

必须用 RFC1918 IPv4 字面地址，不能用 `gmail-sidecar` 服务名。更换邮箱、凭据或权限时递增 `credential.revision` 并重启 cs-agent。此配置仅开放 owner 私聊，定时、唤醒、子 agent 和群默认不开放。

## 工具与限制

| 工具 | 行为 |
| --- | --- |
| `gmail_search` | Gmail 查询语法，默认 10 条，最多 25 条；返回 id、threadId、日期、发件人、主题与最多 200 字符的单行 snippet，不翻页 |
| `gmail_read` | 返回 From/To/Cc/Date/Subject/Message-ID；递归取 text/plain，否则最简 HTML 去标签与实体解码；正文最多 32 KiB，截断注明原始字节数；附件只列名称、类型、字节数 |
| `gmail_send` | 纯文本 UTF-8 邮件，支持 To/Cc/Bcc；不指定 From；地址采用保守格式，逗号分隔，不支持地址组、quoted local-part 或显示名里的逗号；拒绝头部控制字符；无附件发送 |

回复时 `reply_to_message_id` 是 Gmail 邮件 id，不是 RFC Message-ID。服务取得原信的 Message-ID、References 和 threadId 后构造回复，空主题使用 `Re: <原主题>`。

每次发送必须提供 8–128 字符的 `idempotency_key`，同一发送重试复用原 key；已有持久回执直接返回并注明「重复调用，未再次发送」，即使再次传入的正文不同。写盘失败的回执单独保留在内存中，同 key 后续调用只重试保存，不再次发送；保存成功才返回重复成功，否则继续返回存储错误，其他 key 的写入不受这次失败阻塞。key 不应包含邮件内容或地址。单进程内同 key 并发共享一次发送，不同 key 的落盘串行；保留 7 天后 key 可再次发送。仅部署一个 sidecar 实例，不支持多进程共享同一状态目录。

幂等记录与 Gmail 发送不能跨系统原子提交：Google 已接收但响应丢失、进程在落盘前崩溃，或写盘失败后尚未补存就重启时，仍可能重复发送。遇到不确定结果，先搜索「已发送」核对，不能靠换 key 重试。`replay: unsafe` 保留客户端对不确定结果的处理，不承诺 exactly-once。

## 事件端点

`GET /events?cursor=<historyId>&limit=<n>` 是非 MCP 的邮件事件端点，使用与 `/mcp` 相同的 `Authorization: Bearer <GMAIL_SIDECAR_TOKEN>`，并以常量时间比较鉴权。无凭据或凭据错误返回 401；已鉴权的其他 HTTP 方法返回 405（`Allow: GET`）。请求示例：

```http
GET /events?cursor=123456&limit=20 HTTP/1.1
Authorization: Bearer <GMAIL_SIDECAR_TOKEN>
```

`cursor` 可省略；提供时必须为 1–20 位数字字符串，不允许空串。`limit` 默认 20，只接受 1–50 的十进制整数。不合法的参数返回 400 `{ "error": "input" }`。响应使用 JSON，并设置 `Cache-Control: no-store`：

```json
{
  "cursor": "123500",
  "events": [{
    "source": "gmail", "externalId": "mail-id", "occurredAt": 1793066400000,
    "kind": "mail.received", "title": "邮件主题", "summary": "邮件摘要",
    "actor": "sender@example.com", "ref": "mail-id", "labels": ["INBOX", "UNREAD"]
  }],
  "reset": false,
  "more": false
}
```

首次调用省略 `cursor` 时，只读取 profile 的当前 `historyId`，返回空事件和 `reset: true`、`more: false`，从现在开始，不回溯历史。已有游标时，读取 INBOX 的 `messageAdded` 历史，每页 `maxResults=100`，最多 10 页；按 history 记录顺序整条消费，每条记录都有自己的 `id`（historyId），可能包含多条新增邮件。邮件 id 按首次出现顺序去重。

`limit` 是以完整记录为边界的目标数量：去重数量小于 `limit` 时继续取记录；若下一条会使数量超过 `limit`，则在该条之前停止，不拆分记录。例外是本次第一条记录单独就超限时，仍完整消费，保证游标能够推进，因此返回事件数可能超过 `limit`，甚至超过 50。达到 `limit` 后不再消费后续记录。只为已消费记录中的邮件取元数据，并发最多 5 个请求；邮件已删除（元数据 404）时跳过，不补取后续记录来填满数量。

| 字段 | 含义 |
| --- | --- |
| `cursor` | 提前停止或第 10 页后仍有后页时，返回最后一条已消费记录的 `id`。全部记录和分页均读完时，返回最后一页响应的 `historyId`，即使没有新事件或首条记录超限也如此。只有未消费任何记录且仍有后页时，才保留传入游标 |
| `reset` | 首次调用或 history 返回 404（游标过旧）时为 true；此时重新取得当前游标，事件为空，期间遗漏的邮件不补回 |
| `more` | 因数量限制留下未消费记录，或仍有未读取的后页时为 true；所有记录和分页均已读完、或重置时为 false |

收到 `more: true` 后，调用方保存返回的游标，并从该游标继续轮询下一条记录；只要消费过记录，就按该记录的 `id` 推进，不会退回传入游标。例如三条记录的 id 为 `101`、`102`、`103`，每条一封邮件，最终响应的 `historyId` 为 `200`：使用 `limit=1` 连续轮询，会依次返回游标 `101`、`102`、`200`，`more` 依次为 true、true、false。不同记录仍可能引用同一邮件，调用方应按 `externalId` 去重。省略游标可显式重新从现在开始，但会放弃未返回的历史。

事件的 `occurredAt` 优先使用 `internalDate` 毫秒值，缺失或无效时依次退回 Date 头与当前时间。主题、摘要、发件人经过单行化，分别最多 200、500、120 个 Unicode 码点；标签最多 16 项，每项最多 64 个码点。事件只包含元数据，不读取正文或附件。

Google 错误返回 502 `{ "error": "<分类>" }`（如 `permission`、`quota`、`upstream`、`network`、`response`）；本地授权缺失或失效分别返回 503 `auth_missing` / `auth_invalid`。不返回 Google 原始错误。沿用每次 Google 请求 30 秒超时、8 MiB 响应上限与来源限制；多页和多批元数据的总耗时可能超过 30 秒。

每次端点调用产生一行审计，仅包含 `endpoint: "events"`、`duration_ms`、`status`、`fetched` 和可选错误分类。history 404 重置记 `status: "ok"`、`error: "history_reset"`；不记录标题、发件人、摘要或邮件 id。

## 重新授权与排查

`GET /healthz` 无需 Bearer，仅返回 `{ "ok": true, "auth": "ready", "tools": 3 }` 等状态；不执行 Google 请求。ready 代表本地凭据可用，只有真正刷新后才会识别已撤销授权。

| 现象 | 处理 |
| --- | --- |
| `auth: missing` | 宿主运行 `npm run gmail:login`，检查 token 挂载，然后重启 sidecar |
| `auth: invalid` / 授权已失效 | 停止 sidecar，在宿主重新登录，再启动；invalid_grant 后不会自动继续刷新 |
| `POST /mcp` 401 | 检查静态 Bearer 是否完整、两变量是否一致、是否重启两个服务；未鉴权请求不读取 body |
| 工具提示 Gmail 身份验证失败 / 权限不足 | 区别于 sidecar Bearer；检查 Google 授权、两个 scopes、Gmail API 是否启用 |
| 不存在 | 检查 Gmail 邮件 id 与当前邮箱是否一致 |
| 配额或频率超限 | 稍后再试，发送先核对已发送邮件 |
| 网络错误 / 5xx | 仅本次失败，不永久标记授权失效；下一次可刷新 |
| 状态文件写入失败 | 检查 UID、Windows ACL、磁盘空间；发送可能已成功，先核对邮箱 |

`GET /mcp` 返回 405；`DELETE /mcp` 返回 204，不保存 MCP 会话。每个 POST 单独建立 MCP transport，body 上限 1 MiB。每次 Google 请求超时 30 秒、响应上限 8 MiB，不跟随重定向；生产 Gmail origin 固定为 `https://gmail.googleapis.com`，token origin 取管理员客户端配置。search 可能产生多次请求，总耗时仍受 Pi 的 `callMs` 限制。

## 安全边界与验证

Google 凭据只挂入 sidecar；cs-agent 仍持有访问 sidecar 的静态 Bearer，它代表整个 owner 邮箱的只读与发送权限。该 HTTP 内网链路没有 TLS，隔离依赖容器网络与 Bearer 的保密性。凭据不进入镜像或 Git；客户端配置文件属于可信管理员输入。不要将 sidecar 端口公开到公网。

日志为 stdout JSON 行，只含工具名、耗时、状态、错误分类和失败时 Google HTTP 状态，不记录邮件内容、地址、Google 原始错误 JSON 或 token。邮件内容会按现有机制进入 Pi 工具历史，因此仍需按邮箱数据保护 cs-agent 的数据库和备份。邮件正文是外部不可信内容，不授予额外权限。

本地验证使用临时目录与 HTTP 桩，不访问真实邮箱：

```text
npm run typecheck
npm test -- test/sidecar
npm test -- test/architecture
npm test
```
