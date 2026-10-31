# 本机 CS2 Workshop 接入

云端通过 `https://workshop.spcdts.dev/mcp` 调用本机官方 MCP。Tunnel 名为 `cs-workshop-local`，入口仅转发 `/mcp`，其余路径返回 404。本机 MCP 绑定 `127.0.0.1:3721`，使用 Bearer 令牌鉴权。

## 执行与权限

录制、合成、下载、封面和投稿由本机 Workshop / Dispatcher 执行；云端只提交请求、读取回执和按需查询。Demo、视频与工程文件留在本机，不经 R2 中转，不增加云端容器或后台轮询。

`cs2-workshop` 默认仅 owner 私聊及其共享上下文的网页会话可用。群聊需要既有 MCP 授权，写工具继续经过审批；事件工具允许列表为空，不自动开放给定时任务。配置保留 `replay: unsafe`。包含修改动作的 `workshop_results` 不列为只读。

耗时动作由 Workshop 原生异步接口接受稳定 `request_id`，通过 `workshop_status(action="request", request_id=...)` 查询回执及原操作结果。同一任务沿用原编号，参数改变必须使用新编号；超时或断线后先查询，不能自动重新录制或投稿。业务状态、CAS、资源锁和任务恢复均由 Workshop 管理；对 Workshop 的改造统一提给 `cs-master` 会话。

## 本机文件

以下文件均在主工作区，已由 Git 忽略：

| 文件 | 内容 |
| --- | --- |
| `secrets/workshop/mcp-token.txt` | 本机 MCP 的原始令牌，云端 secret 加上 `Bearer ` 前缀 |
| `secrets/workshop/tunnel-credentials.json` | cloudflared 创建的 Tunnel 凭据 |
| `data/workshop-bridge/cloudflared.exe` | 从 Cloudflare 官方发布下载的程序 |
| `data/workshop-bridge/local.json` | 官方 CLI 路径、cloudflared 路径、允许访问的本机根目录 |
| `data/workshop-bridge/tunnel.json` | 本机管理的 Tunnel 配置 |
| `data/workshop-bridge/*.log` | 连接进程日志，重启时保留上一份 |

`local.json` 示例：

```json
{
  "cli": "C:/Users/SPCDTS/Applications/CS2 Highlights Workshop/cs2-highlights-cli.exe",
  "cloudflared": "D:/project/cs_agent/data/workshop-bridge/cloudflared.exe",
  "roots": ["D:/cs_cs/demos", "D:/cs_cs/highlights"]
}
```

`tunnel.json` 示例（替换 Tunnel ID 与凭据绝对路径）：

```json
{
  "tunnel": "<Tunnel ID>",
  "credentials-file": "D:/project/cs_agent/secrets/workshop/tunnel-credentials.json",
  "protocol": "http2",
  "metrics": "127.0.0.1:20241",
  "ingress": [
    {
      "hostname": "workshop.spcdts.dev",
      "path": "^/mcp$",
      "service": "http://127.0.0.1:3721",
      "originRequest": {"httpHostHeader": "127.0.0.1:3721"}
    },
    {"service": "http_status:404"}
  ]
}
```

私有目录只授予当前用户和 SYSTEM 访问。令牌与完整请求头不能写入仓库、命令行参数或调试日志。轮换 MCP 令牌时同步更新云端 secret 并重启本机连接。

## 命令行配置与运行

Cloudflare 使用官方命令行；`cloudflared tunnel login` 需要一次浏览器域名授权。已存在的 Tunnel 和 DNS 不重复创建，也不使用覆盖 DNS 的参数。

```powershell
& .\data\workshop-bridge\cloudflared.exe tunnel login
& .\data\workshop-bridge\cloudflared.exe tunnel create --credentials-file .\secrets\workshop\tunnel-credentials.json cs-workshop-local
& .\data\workshop-bridge\cloudflared.exe tunnel route dns cs-workshop-local workshop.spcdts.dev
```

云端 `workers/mcp.json` 仅保存 `CS2_WORKSHOP_AUTHORIZATION` 的引用。`workers/scripts/put-secrets.sh` 会在本机令牌存在时上传该 secret，值走 stdin。随后按仓库 CI 部署云端配置，并在管理页刷新 `cs2-workshop` 的工具目录。

准备好上述本机文件后，在主工作区执行：

```powershell
.\scripts\workshop-local.ps1 -Action Install
.\scripts\workshop-local.ps1 -Action Status
# 维护官方 CLI 前停止连接，更新后重新 Install
.\scripts\workshop-local.ps1 -Action Stop
```

计划任务 `cs-agent-workshop` 在当前用户登录后隐藏运行，使用交互会话和普通权限。不要安装成 SYSTEM 服务，Steam / CS2 需要用户桌面。电脑关机、睡眠或用户未登录时，本地能力不可用。

连接脚本仅守护官方 MCP 与 cloudflared 两个进程。进程退出后等待 5 秒重启，不查询或重放业务任务。停止连接不等于取消 Dispatcher 中的制作任务；维护前仍按 Workshop 既有流程确认任务状态。可直接运行 `node scripts/workshop-local.mjs <主工作区路径>` 进行诊断。

## 网络与验证

系统代理与虚拟网卡是不同的入口。本机曾出现 FlClash 虚拟网卡将 Tunnel 流量送入不可用代理线路、TLS 被断开的情况；关闭虚拟网卡后直连验证成功。若恢复虚拟网卡，需要给 `cloudflared.exe` 配置可用的独立分流，并重新验证。不要把虚拟 DNS 地址写入 Tunnel 配置，也不要关闭 TLS 校验。

Tunnel 使用出站 7844 端口，无需开放本机入站端口。现有配置使用 HTTP/2。检查 `tunnel.log` 中的 `Registered tunnel connection`，以及本机 `http://127.0.0.1:20241/ready`；预检查某个区域失败不等于实际连接失败。

只读验收包括：无令牌返回 401、有令牌获取 9 个工具与 3 个资源、读取指南和 `workshop_status(action="machine")`、云端刷新目录。异步幂等与失联行为由 Workshop 的隔离测试验证，接入测试不启动真实制作或投稿。

参考：[Cloudflare 命令行建 Tunnel](https://developers.cloudflare.com/tunnel/features/locally-managed-tunnels/create-local-tunnel/)、[运行参数](https://developers.cloudflare.com/tunnel/reference/run-parameters/)。
