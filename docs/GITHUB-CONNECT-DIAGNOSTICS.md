# GitHub 连接失败诊断

`connect/start` 与 `connect/complete` 的失败响应仅返回固定 `error` 和服务端生成的 `requestId`；响应头 `X-Request-ID` 可关联同一次请求。不要上传完整 HAR 或 OAuth 回调查询串。

服务端只记录 `event=github_connect_failed`、`requestId`、`operation`、白名单 `stage`、固定 `code` 和 HTTP `status`。不记录原异常 message/stack，也不记录 token、code、state、browser、verifier、URL query、header 或配置值。

- `state_missing`：没有待处理状态，或已消费；`state_expired`：原十分钟 TTL 已过。
- `state_binding`：当前管理员/browser 绑定不同；`state_epoch`：授权状态版本已改变。
- `configuration`：配置门槛；`token_exchange`：code/PKCE 校验或换 token。
- `user`、`discover`、`inspect`：用户身份、安装发现及用户仓库权限。
- `app_jwt`、`install_repo`：App 签名与安装仓库查询；`vault`：加密。
- `persist`、`snapshot`：持久化及返回快照；`revoked`：连接中被撤权。
- `rpc`：DO 构造/传输或返回处理失败，无法确认已进入业务阶段；不能把它归因于用户授权。

配置错误返回 503，授权/状态错误返回 400，容量或已识别的 GitHub 限流返回 429，上游不可用返回 502，未知错误返回 500。输入 JSON/schema 校验仍沿用原 400 响应。

DO 内部完成分类后返回普通结构化结果，不依赖跨 RPC 保留自定义 Error 属性。日志阶段不等于根因；例如 `token_exchange` 不能单独区分 client secret、code 或 PKCE。

不延长 TTL、不放松授权、不自动重放 code。state 仍在远端请求前一次性消费；前端仍会清理已确认尝试的 sessionStorage。排障先保存首次失败的安全 error/requestId 并关联日志，不反复点击旧确认按钮。此改动仅提供诊断，不能据此声称已修复某次线上授权失败。
