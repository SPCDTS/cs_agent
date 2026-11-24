# Cua 设备目录部署

这套模板默认让 cs-agent 读取已登记设备及其 Driver 工具清单，可按设备开放主机名、macOS 与 Windows 窗口列表，以及 macOS 单窗口截图。启用后，主人与获分配该设备的会话及其获授权子任务可以执行这些读取。控制机需有 Linux、支持 `LoadCredential` 的 systemd、Caddy 2 和 Node.js 24。上游 `cua-sdk-v0.31.0` 对应的 CLI 与 daemon 为 0.31.0，同一提交的 `cua-relay` 和设备端 `cua-spacesd` 为 0.17.2。示例域名和机器 ID 需按本次接入填写。[Cua 固定版本](https://github.com/trycua/cua/tree/78fe31378569aab57ddb5131a08fc90fc3c6fbb9) [spacesd 版本](https://github.com/trycua/cua/blob/78fe31378569aab57ddb5131a08fc90fc3c6fbb9/libs/cua-spacesd/VERSION)

## 规划设备身份

每台设备分配一个长期保留的 machine-id、一个私有 Relay 实例和一个目录端口。公网仅有一个 TLS 域名。Caddy 按精确的 join 路径和机器头选择 Relay，Relay 用本机专属的注册令牌验证 Bearer。默认每个私有目录端口仅放行该机器的 `SystemService/GetCapabilities`、`DriverService/ListTools` 两条 gRPC 请求。

| 设备示例 | 公网 join 使用的 machine-id | 原生 Relay 回环端口 | 目录回环端口 | cs-agent 授权使用的 Space ID |
| --- | --- | --- | --- | --- |
| 工作用 Mac | `computer-alpha` | 18181 | 18281 | `direct:127.0.0.1:18281` |
| Windows VM | `computer-bravo` | 18182 | 18282 | `direct:127.0.0.1:18282` |

Cua 根据 URL 的主机和端口生成 direct ID，路径中的 machine-id 仅参与请求路由。同一机器重连时保留原对应关系。新机器始终分配新端口。示例的每一行要同步写入 Caddy 的公网 join 和私有目录两个位置。[Cua 的 Space ID 生成逻辑](https://github.com/trycua/cua/blob/78fe31378569aab57ddb5131a08fc90fc3c6fbb9/libs/cua/crates/cua-spaces/src/spaces.rs#L1355-L1383)

## 安装控制机

Linux amd64 可从 [Relay 构建工作流](../../.github/workflows/build-cua-relay.yml) 下载产物，先用附带的 `.sha256` 校验压缩包，再解包并运行 `sha256sum -c SHA256SUMS` 校验可执行文件，`BUILD-INFO` 记录上游提交和构建参数。

1. 创建专用系统账号和组 `cua-directory`。安装核对过发布校验的 CLI 到 `/usr/local/bin/cua`。Relay 可在相同 CPU 架构的 Linux 构建机检出上述上游提交，用 `cargo build --locked --release --manifest-path libs/cua-spacesd/Cargo.toml -p cua-relay` 构建并将二进制安装到控制机的 `/usr/local/bin/cua-relay`。从本仓库执行 `npm --prefix runner ci`、`npm --prefix runner run build:cua`，把生成的 `runner/dist/reverse-mcp-bridge.cjs` 安装到 `/opt/cs-agent/cua/`，并确认 `/usr/bin/node` 是 Node.js 24 或更高版本。
2. 将本目录的四个 `.service` 文件安装到 `/etc/systemd/system/` 并运行 `systemctl daemon-reload`。在 `/etc/cs-agent/cua/` 建立 `relays/` 和 `spaces/`，目录仅准 root 访问。以下凭据文件均由 root 持有，权限为 `0600`。
3. 每台设备准备两个独立、随机的秘密。*注册令牌*只给该设备和它的 Relay，放入 `relays/18181.token` 或 `relays/18182.token`，每个文件恰好一行。*设备令牌*供设备验证目录请求，稍后写入对应的 `spaces/<目录端口>.env`。可使用密码管理器分发。令牌应直接写入受保护的文件，避免终端输出和命令行参数。
4. 按表填写 [Caddyfile](Caddyfile)。域名应直接解析到控制机，公网只开放 443/TCP。若与其他站点共用 Caddy，按下节核对完整配置与监听端口。运行 `systemctl enable --now cua-relay@18181 cua-relay@18182 cua-directory`。
5. 在 cs-agent「模型与接入」展开「接入或管理远程 MCP 服务」，服务名称填 `cua`，认证选择「反向 WebSocket」，点击「保存连接」。管理员用密码管理器生成一枚独立的 64 位随机十六进制令牌，在 `Authorization` 的密码框填入令牌，点击「保存凭据并检测」。首次操作时桥尚未启动，稍后可重新检测。
6. 把自动生成的 WSS 地址及同一枚令牌写入 `/etc/cs-agent/cua/bridge.env`，格式如下。令牌值直接填原文。运行 `systemctl enable --now cua-directory-bridge`，在管理台「刷新服务」，选中 `cua` 并确认显示「节点在线」。点击「检测连接与工具」，勾选 `list_spaces` 和 `list_tools`，点击「启用选中工具」。资源 URI 前缀留空。

```ini
REVERSE_MCP_URL=wss://agent.example.org/mcp/reverse/cua
REVERSE_MCP_TOKEN=<管理员生成并在服务凭据中保存的令牌>
```

目录 daemon 和登记命令均设置 `CUA_CREDENTIAL_STORE=file`，服务账号将凭据保存在专用的 `0700` 状态目录 `/var/lib/cs-agent-cua` 中。原生 MCP 仅监听 Unix socket。daemon 和各 Relay unit 的 systemd IP 策略只允许回环网络。桥会出站连接上面指定的 cs-agent WSS 地址。

### 共享 Caddy 时仅开放 443/TCP

模板的全局 `auto_https disable_redirects` 关闭自动 HTTP 跳转，作用于同一 Caddy 实例上的所有站点。ACME 的 HTTP-01 由各站点的证书签发策略单独控制。Relay 和同机 LLM 等所有使用 ACME 的公网域名都需配置签发方式。采用 TLS-ALPN-01 时，将下段加入每个相关站点现有的 `tls` 配置，并确保 443/TCP 上的证书验证流量直接抵达该 Caddy。已有通过 DNS-01 签发的站点可沿用现有策略。检查全局选项、导入文件和显式的 `:80`、`http://域名` 站点。[Caddy 自动 HTTPS](https://caddyserver.com/docs/caddyfile/options#auto-https) · [ACME 签发与挑战配置](https://caddyserver.com/docs/caddyfile/directives/tls#acme)

```caddyfile
tls {
    issuer acme {
        disable_http_challenge
    }
}
```

在目标机器运行 `caddy adapt --config /etc/caddy/Caddyfile --adapter caddyfile`，核对两个公网域名都被预期的签发策略覆盖、使用 TLS-ALPN-01 的域名禁用了 HTTP-01，并检查适配结果中的监听地址。再运行 `caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile`。切换窗口内重载后，用 `ss -ltn '( sport = :80 or sport = :443 )'` 确认仅有 443 监听，并分别验证两个域名的 HTTPS 服务与证书。后续续期在 443/TCP 或已配置的 DNS 验证通道完成。

### 1 GiB 控制机上每台设备的开销

在 Debian amd64 的 1 GiB VPS 上，内核可见内存 967 MiB，无 swap。已有共享 Caddy、目录 daemon 和一个原生 Relay，反向 Node 桥当时未启动。测试开始时整机 `MemAvailable` 为 651 MiB。以下内存单位均为 MiB。RSS 包含共享页，PSS 按进程分摊共享页。systemd 的 cgroup 按内核记账，与进程 PSS 口径不同。

| 进程与状态 | 每进程 RSS | 每进程 PSS | 打开的 FD | unit 当前 / 历史峰值内存 |
| --- | ---: | ---: | ---: | ---: |
| 已有 Caddy | 53.0 | 53.0 | 7 | 17.4 / 19.6 |
| 已有目录 daemon | 84.0 | 81.7 | 17 | 86.2 / 86.5 |
| 已有 Relay，启动探针前 | 18.7 | 15.3 | 10 | 7.5 / 9.5 |
| 新增三个独立 Relay，空闲 | 18.4–18.8 | 9.6–9.8 | 10 | — |
| 新增 Relay 各连接一个设备 | 19.9–20.3 | 10.1–10.2 | 11 | — |
| 三台同时查目录，每个 Relay 的采样峰值 | 19.9–20.3 | 10.1–10.2 | 12 | — |

三个临时 Relay 各用独立的回环地址和凭据。三个合成设备保持 WSS 连接，每台连续读取固定的 Driver 目录 40 次，合计成功 120 次。查询期间采样 66 次。查询末尾整机可用内存为 598 MiB，包含临时 TLS 代理、合成设备及请求进程的开销。退出测试进程、确认监听关闭后恢复至 654 MiB。

这组数据可用于估算少量目录设备的常驻开销。该样本的并发规模为三台，未涵盖桥、真实截图、大目录和同机其他业务的峰值。扩容时先启动实际要用的桥和同机服务，按设备逐步增加并发，记录代表性请求期间的最低 `MemAvailable`。可用 `systemctl show cua-relay@18181 -p MainPID -p MemoryCurrent -p MemoryPeak -p LimitNOFILE` 检查一个实例，再用对应 PID 的 `/proc/<PID>/smaps_rollup` 和 `/proc/<PID>/fd/` 核对 PSS 和文件描述符。用同机业务与桥在高峰期间的实测波动预留余量，再决定是否增加下一台。

## 登记一台设备

在目标设备的原生环境内运行 `cua-spacesd 0.17.2` 的 `join`。以下是 macOS 示例，Windows 使用同一组参数，把文件路径替换为受该用户 ACL 保护的绝对路径。join 以前台进程运行，持续连接需交给该设备已有的服务管理器。为机器 ID 文件选择可写且可持久化的路径。

```sh
cua-spacesd join --relay wss://relay.example.org \
  --relay-token-file /protected/registration.token \
  --machine-id computer-alpha --machine-id-file /protected/machine-id \
  --token-file /protected/device.token --no-mcp --quic-port 0
```

每台设备使用自己的 `registration.token` 和 `device.token`。join 会向 `/relay/v1/connect` 发起 WebSocket 握手，携带 `X-Cua-Machine-Id` 和注册 Bearer。设备原生 HTTP MCP 可关闭，Driver 目录查询使用 gRPC。[官方 join 参数](https://github.com/trycua/cua/blob/78fe31378569aab57ddb5131a08fc90fc3c6fbb9/libs/cua-spacesd/crates/cua-spacesd/src/main.rs#L334-L389) [官方注册协议](https://github.com/trycua/cua/blob/78fe31378569aab57ddb5131a08fc90fc3c6fbb9/libs/cua-spacesd/crates/cua-relay/src/lib.rs#L24-L39)

在控制机写入 `/etc/cs-agent/cua/spaces/18281.env`。设备令牌需与相应机器的 `device.token` 相同。

```ini
MACHINE_ID=computer-alpha
CUA_ENV_TOKEN=<设备专属令牌>
```

运行 `systemctl start cua-directory-register@18281`，仅在设备已加入且能力握手成功后登记该条目。Cua 默认采用 `GetCapabilities.hostname` 作为设备卡名称。旧版曾显式指定名称时，安装新版 register unit、运行 `systemctl daemon-reload`，然后对仍在线的设备重新执行同一个 register 服务即可刷新名称。Space ID 和配对凭据保持有效。第二台设备使用另一份文件和端口。到 cs-agent「权限与运维」→「Cua 设备分配」，点「刷新设备与分配」，选择群聊或私聊，核对设备名与完整 Space ID，勾选该设备并点击「保存分配」。会话可列出已分配设备并查看其 Driver 工具清单。列表中的状态反映 Cua 最近的握手结果。管理台可另设显示名（支持中文），清除显示名后恢复设备默认名称。模型按完整 Space ID 调用设备。

## 为一台测试设备启用主机名与窗口读取

在目标设备已用独立设备令牌完成登记后，修改控制机 Caddyfile 中该设备现有的回环站点。以下配置对应表中的工作用 Mac。两条 `import` 必须使用同一台设备的 machine-id 和 Relay 端口。沿用旧模板时，同步把片段定义与已启用的 `import owner-inspection` 更名为 `device-inspection`。

```caddyfile
http://127.0.0.1:18281 {
	import device-inspection computer-alpha 18181
	import directory computer-alpha 18181
}
```

用 `caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile` 检查后重新加载配置，并核对 `ss -ltn` 中该端口仅监听 `127.0.0.1`。公网入口继续只在 443/TCP 接受指定机器的 join。Caddy 在回环路径上放行两条额外的 gRPC 方法，并将请求的设备 Bearer 交给该机的 spacesd 验证。设备端需使用 `--token-file`。掌握设备令牌的本地进程可以直接调用这两条原生 RPC，设备令牌应只供该设备和专用目录账号使用。

| Cua MCP 工具与参数 | 设备原生接口 | 结果 |
| --- | --- | --- |
| `space_bash` 传入 `space` 和 `command="hostname"` | `ProcessService/StartProcess`，固定运行 `hostname`，5 秒超时 | 校验正常退出后返回主机名 |
| `call_tool` 传入 `space`、`service="driver"`、`tool="list_windows"` 和 `arguments` | `DriverService/CallTool`，可在 `arguments` 中传应用名 `app`、进程号 `pid` 或留空对象 | 返回 macOS 或 Windows 上匹配的窗口及其 PID、窗口 ID |
| 同一 `call_tool` 传入 `tool="get_window_state"`，`arguments` 传选中行的 `pid` 和 `window_id` | `DriverService/CallTool`，按两个 ID 读取该窗口，再以相同 PID 调用 `list_windows` 复核归属 | 返回指定 macOS 窗口的单张 PNG |

先在管理台核对已获分配的群聊和私聊，再为 `cua` 重新检测并启用所需的 `space_bash` 或 `call_tool`。已有分配对新启用的读取工具同时生效。测试截图时，在对话里选定 Mac 与专用测试窗口，让模型先列出窗口再按返回的 ID 截图。设备的登录用户需已允许系统录制。返回的 `structuredContent.imageId` 可用于本会话的 `send_message.images`。关闭窗口后重复请求应返回错误。被动事件、agent 回合及定时任务不能执行这些读取。Windows 窗口列表依据固定版本的 Driver 契约和合成响应测试验证，本轮未做 Windows 真机测试。Windows Driver 的截图路径可能回退到读取桌面像素，cs-agent 仅在 macOS 开放单窗口截图。[Windows Driver 的截图回退](https://github.com/trycua/cua/blob/78fe31378569aab57ddb5131a08fc90fc3c6fbb9/libs/cua-driver/rust/crates/platform-windows/src/capture.rs#L645-L675)

要恢复设备的目录模式，移除该回环站点的 `import device-inspection`，校验后重新加载 Caddy。

## 临时 Space 的供应边界

在开放设备 shell 时，请将控制机目录 daemon 的 Unix socket 和供应凭据保留在专用服务账号下。拥有这些凭据的操作系统账号可以直接使用 Cua 管理资源。

本部署将本机 Space 的创建和销毁留在 Cua 管理端。Cua 0.31.0 用 `local:<名称>` 标识本机实例，同名重建后 ID 可以复用。原生 MCP 的 `delete_space` 只接收 `space`，会递归删除子 Space。即便 cs-agent 记下本会话创建过哪个 ID，稍后删除也可能命中同名的新实例或其他会话的子 Space。[本机 Space ID](https://github.com/trycua/cua/blob/78fe31378569aab57ddb5131a08fc90fc3c6fbb9/libs/cua/crates/cua-spaces/src/id.rs#L70-L90) [原生 MCP 删除参数](https://github.com/trycua/cua/blob/78fe31378569aab57ddb5131a08fc90fc3c6fbb9/libs/cua/crates/cua-spaces/src/mcp/tools.rs#L363-L366) [子树删除逻辑](https://github.com/trycua/cua/blob/78fe31378569aab57ddb5131a08fc90fc3c6fbb9/libs/cua/crates/cua-spaces/src/tree.rs#L235-L275)

本机 `create_space.timeout` 限制等待实例就绪的时长。设置到期删除需要后续一步，若控制机在两步之间中断，实例可能持续运行。因此当前目录桥和 Worker 都拒绝原生 `create_space`、`delete_space`。要开放主人会话自动回收，供应端需要在创建时保证到期回收，或支持针对具体实例的持久回收任务，并保证回收仅作用于本会话创建的资源。这些结论针对本机后端，云供应端尚待单独验证。[本机创建参数](https://github.com/trycua/cua/blob/78fe31378569aab57ddb5131a08fc90fc3c6fbb9/libs/cua/crates/cua-spaces/src/spaces.rs#L3318-L3347) [设置 Space 到期时间](https://github.com/trycua/cua/blob/78fe31378569aab57ddb5131a08fc90fc3c6fbb9/libs/cua/crates/cua-spaces/src/lifetimes.rs#L115-L157)

## 撤销与轮换

先在管理台移除设备的所有会话分配，再从公网和目录两组 Caddy 路由移除该机并 reload，停止相应的 Relay 实例。使用运行目录 daemon 的账号清理控制机上的登记。以下示例仅移除第一台设备的本地目录条目。归档已使用的端口与 machine-id，后续设备分配全新组合。

```sh
sudo -u cua-directory env CUA_HOME=/var/lib/cs-agent-cua CUA_CREDENTIAL_STORE=file \
  CUA_TELEMETRY=0 CUA_MESH=off CUA_RELAY_URL=http://127.0.0.1:1 \
  /usr/local/bin/cua --daemon /run/cs-agent-cua/cua.sock spaces rm direct:127.0.0.1:18281
```

同一设备只轮换注册令牌时，更新设备和控制机的注册文件并重启对应 Relay。设备令牌轮换后，重启设备端 join，并重新执行该设备的 register unit。在管理台暂停 `cua` 服务会保留已有设备分配，暂停期间仍可撤回分配。轮换桥的 WSS 凭据会清空原分配。更新控制机桥凭据、重启并核对连接后，按完整 Space ID 重新向所需会话分配设备。
