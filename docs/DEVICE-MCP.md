# 用 Cua 接入设备与临时环境

cs-agent 只登记一个名为 `cua` 的 MCP 服务。Cua Spaces 提供设备目录和临时环境，Cua Relay 连接已共享的机器，Cua Driver 提供目标系统上的桌面工具。cs-agent 管理会话能访问哪些 Space，以及哪些操作需要审批。

## 配置一次 Cua 控制节点

选一台 Worker 能通过 HTTPS 访问的常在线机器。下面以 Linux 服务账户 `cua`、主目录 `/home/cua` 为例。该账户负责聚合多个设备的目录，持有 Cua 登录会话。使用独立服务账户可避免把它的套接字和账户凭据交给获准使用某台设备的群成员。

1. 在控制节点安装 [Cua Spaces](https://cua.ai/download)。本文的聚合 MCP 已用 Cua CLI 0.31.0 验证。
2. 以服务账户运行 `cua auth login --remote --no-onboarding`，在浏览器确认 Cua 账户。紧接着运行 `cua devices enroll` 登记这个控制节点。若出现一次性代码，在已获准的设备上用 `cua devices approve <代码>` 确认，再用 `cua spaces ls` 核对目录。
3. 用服务管理器运行 `cua daemon start --socket /home/cua/.cua/cua.sock --loopback off --foreground`。使用已有 daemon 时可直接复用它的 Unix socket。这个 daemon 的 `/mcp` 返回 `cua-spaces`，能列出账户设备并在指定后端创建 Space。
4. 在 HTTPS 入口校验专用 Bearer 凭据，只转发精确路径 `/mcp`。以下 Caddy 示例要求代理进程能访问同用户的 0600 socket。将示例域名改为实际域名，先在服务管理器中将 `CS_AGENT_CUA_TOKEN` 设置为密码管理器生成的高熵随机值，再启动代理。

```caddyfile
cua.example.org {
    @mcp {
        path /mcp
        header Authorization "Bearer {$CS_AGENT_CUA_TOKEN}"
    }
    handle @mcp {
        reverse_proxy unix//home/cua/.cua/cua.sock {
            header_up -Authorization
            header_up Host localhost
            flush_interval -1
        }
    }
    handle {
        respond 403
    }
}
```

5. 打开 cs-agent「模型与接入 → MCP 与设备 → 个人设备 · Cua Spaces → 配置 Cua MCP」。保存服务地址（例 `https://cua.example.org/mcp`），把 `Authorization` 请求头设为 `Bearer <专用凭据>`，检测并启用所需工具。返回设备面板，点「刷新设备」。
6. 核对目录中能看到 `list_spaces`、`list_tools` 和 `create_space`。若检测结果只有点击、输入等桌面动作，当前地址指向了单机 Driver，应将它改为控制节点的聚合入口。

Cua 登录会话保存在控制节点，Worker 加密保存访问 HTTPS 入口的凭据。Cloudflare 账户管理通过管理台中单独的「Cloudflare 账户管理」授权，设备接入使用 Cua 账户。

## 接入 Mac、Windows VM 或运行临时环境的机器

在 [Cua 设备管理](https://app.cua.ai/machines) 中添加计算机，或在目标机安装 Cua 后运行下列命令。持久 Windows VM 在来宾的交互用户会话内运行。设备主动连接 Relay，名称会出现在控制节点的目录中。

```sh
cua host setup --name "开发机" --share desktop
cua host status
```

`--share desktop` 会共享该用户的桌面、命令行与文件。通过 Cua 应用添加的机器若只开放了运行 Spaces，在 Computers 页面开启该机的桌面共享。macOS 需要在系统设置中授予屏幕录制和辅助功能权限。Windows 桌面需要用户登录并解锁。在准备承载临时环境的机器上使用 `cua host setup --name "构建机" --share spaces`，并为所需镜像安装 Cua 支持的容器或虚拟机运行时。操作系统、镜像与宿主运行时决定能创建哪种临时环境。[Cua 设备接入指南](https://cua.ai/docs/spaces/guides/add-a-computer)

## 模型怎样使用

下表使用 Cua 的原始工具名。模型在 Code Mode 目录中会看到形如 `mcp_cua_list_spaces_<契约摘要>` 的名字。增加设备只会在目录增加一张卡片。

| 操作 | 调用与返回 |
| --- | --- |
| 找到设备 | `list_spaces({})` 返回允许访问的 Space，含显示名、完整 ID、系统、状态和 Cua 上报的能力与服务。使用目录中的完整 ID。 |
| 查桌面能力 | `list_tools({space, service:"driver"})` 返回该设备的工具名。再传 `name:"list_windows"` 可读取匹配工具的完整参数契约。 |
| 操作桌面 | 若目录列出 `list_windows`，调用 `call_tool({space, service:"driver", tool:"list_windows", arguments:{}})`。匹配参数和界面操作均以该设备 Driver 实际返回的契约为准。 |
| 运行命令 | `space_bash({space, command:"hostname"})`。长任务使用 `space_job`，保存 Space 与作业 ID，按工具契约查状态、读取输出或取消。 |
| 使用临时环境 | 主人通过 `create_space` 指定可用的宿主、镜像、类型与名称。取创建结果的 ID 操作，任务结束后用 `delete_space({space})` 回收这次创建的环境。超时后先查目录和状态，再决定如何继续。 |

群授权在「权限与运维 → MCP 群授权与审批」中设置。选择 `cua`、成员、工具和允许的完整 Space ID。群内的设备目录按 ID 过滤，桌面控制、Shell 和作业默认逐次审批。子任务继续受派发时的范围及当前授权约束。临时环境创建与删除仅开放给主人。

## 从旧设备服务切换

1. 升级前先完成或取消仍在运行的任务。记录旧设备与其 Tunnel、DNS 的对应关系。仍能使用旧管理台时，可在设备端迁移完毕后使用旧版「撤销接入」清理对应的云端资源。
2. 在每台旧设备上用原来的客户端和登录账户执行 `node cs-agent-device.cjs remove-service`。自定义状态目录需加原先的 `--state-dir`。结束手动启动的旧进程，停用原有 Windows 宿主 runner。持久 VM、工作目录和项目文件继续保留。
3. 部署新版后，Registry 首次初始化时清除旧配对表及其生成的 MCP 记录。原 `windows`、`desktop` 入口按服务 ID 和历史工具契约识别。检查管理台是否有自行改名的旧入口，确认后移除。旧授权不授予新服务。
4. 若还留有旧 Cloudflare 资源，按迁移前的记录核对并删除对应的 `cs-agent-device-<UUID>` Tunnel 及 `device-<去除连字符的 UUID>.<域名>` DNS 记录。专用于这些 Tunnel 的旧 API Token 可在核实用途后撤销。
5. 在 Cua 中重新连接设备，刷新目录，在主人会话对选定的设备运行 `hostname` 并读取 Driver 工具目录，再按需授予群权限。
