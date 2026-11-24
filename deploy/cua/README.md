# Cua 设备目录部署

这套模板默认让 cs-agent 读取已登记设备及其 Driver 工具清单，可按设备启用主人交互回合的主机名读取和 Mac 单窗口截图。控制机需有 Linux、支持 `LoadCredential` 的 systemd、Caddy 2 和 Node.js 24。上游 `cua-sdk-v0.31.0` 对应的 CLI 与 daemon 为 0.31.0，同一提交的 `cua-relay` 和设备端 `cua-spacesd` 为 0.17.2。示例域名、机器 ID 和展示名均需按本次接入填写。[Cua 固定版本](https://github.com/trycua/cua/tree/78fe31378569aab57ddb5131a08fc90fc3c6fbb9) [spacesd 版本](https://github.com/trycua/cua/blob/78fe31378569aab57ddb5131a08fc90fc3c6fbb9/libs/cua-spacesd/VERSION)

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
4. 按表填写 [Caddyfile](Caddyfile)。这份独立控制机配置使用公网 443/TCP 提供 WSS，通过 TLS-ALPN-01 在同一端口签发和续期证书；80 端口保持关闭。域名应直接解析到控制机。检查 `caddy validate --config /etc/caddy/Caddyfile` 和 `ss -ltn` 的实际监听结果。与现有站点共用 Caddy 时，全局跳转选项会影响同一实例内的其他站点。运行 `systemctl enable --now cua-relay@18181 cua-relay@18182 cua-directory`。
5. 在 cs-agent「模型与接入」展开「接入或管理远程 MCP 服务」，服务名称填 `cua`，认证选择「反向 WebSocket」，点击「保存连接」。管理员用密码管理器生成一枚独立的 64 位随机十六进制令牌，在 `Authorization` 的密码框填入令牌，点击「保存凭据并检测」。首次操作时桥尚未启动，稍后可重新检测。
6. 把自动生成的 WSS 地址及同一枚令牌写入 `/etc/cs-agent/cua/bridge.env`，格式如下。令牌值直接填原文。运行 `systemctl enable --now cua-directory-bridge`，在管理台「刷新服务」，选中 `cua` 并确认显示「节点在线」。点击「检测连接与工具」，勾选 `list_spaces` 和 `list_tools`，点击「启用选中工具」。资源 URI 前缀留空。

```ini
REVERSE_MCP_URL=wss://agent.example.org/mcp/reverse/cua
REVERSE_MCP_TOKEN=<管理员生成并在服务凭据中保存的令牌>
```

目录 daemon 和登记命令均设置 `CUA_CREDENTIAL_STORE=file`，服务账号将凭据保存在专用的 `0700` 状态目录 `/var/lib/cs-agent-cua` 中。原生 MCP 仅监听 Unix socket。daemon 和各 Relay unit 的 systemd IP 策略只允许回环网络。桥会出站连接上面指定的 cs-agent WSS 地址。每台机器有一个 Relay 进程，增加机器时需按实际同时在线数核对控制机内存和文件描述符。

## 登记一台设备

在目标设备的原生环境内运行 `cua-spacesd 0.17.2` 的 `join`。以下是 macOS 示例，Windows 使用同一组参数，把文件路径替换为受该用户 ACL 保护的绝对路径。join 以前台进程运行，持续连接需交给该设备已有的服务管理器。为机器 ID 文件选择可写且可持久化的路径。

```sh
cua-spacesd join --relay wss://relay.example.org \
  --relay-token-file /protected/registration.token \
  --machine-id computer-alpha --machine-id-file /protected/machine-id \
  --token-file /protected/device.token --no-mcp --quic-port 0
```

每台设备使用自己的 `registration.token` 和 `device.token`。join 会向 `/relay/v1/connect` 发起 WebSocket 握手，携带 `X-Cua-Machine-Id` 和注册 Bearer。设备原生 HTTP MCP 可关闭，Driver 目录查询使用 gRPC。[官方 join 参数](https://github.com/trycua/cua/blob/78fe31378569aab57ddb5131a08fc90fc3c6fbb9/libs/cua-spacesd/crates/cua-spacesd/src/main.rs#L334-L389) [官方注册协议](https://github.com/trycua/cua/blob/78fe31378569aab57ddb5131a08fc90fc3c6fbb9/libs/cua-spacesd/crates/cua-relay/src/lib.rs#L24-L39)

在控制机写入 `/etc/cs-agent/cua/spaces/18281.env`。DISPLAY_NAME 可带空格。设备令牌需与相应机器的 `device.token` 相同。

```ini
MACHINE_ID=computer-alpha
DISPLAY_NAME="工作用 Mac"
CUA_ENV_TOKEN=<设备专属令牌>
```

运行 `systemctl start cua-directory-register@18281`，仅在设备已加入且能力握手成功后登记该条目。第二台设备使用另一份文件和端口。到 cs-agent「权限与运维」→「Cua 设备分配」，点「刷新设备与分配」，选择群聊或私聊，核对设备名与完整 Space ID，勾选该设备并点击「保存分配」。会话可列出已分配设备并查看其 Driver 工具清单。列表中的状态反映 Cua 最近的握手结果。

## 为一台测试设备启用主机名与窗口读取

在目标设备已用独立设备令牌完成登记后，修改控制机 Caddyfile 中该设备现有的回环站点。以下配置对应表中的工作用 Mac。两条 `import` 必须使用同一台设备的 machine-id 和 Relay 端口。

```caddyfile
http://127.0.0.1:18281 {
	import owner-inspection computer-alpha 18181
	import directory computer-alpha 18181
}
```

用 `caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile` 检查后重新加载配置，并核对 `ss -ltn` 中该端口仅监听 `127.0.0.1`。公网入口继续只在 443/TCP 接受指定机器的 join。Caddy 在回环路径上放行两条额外的 gRPC 方法，并将请求的设备 Bearer 交给该机的 spacesd 验证。设备端需使用 `--token-file`。掌握设备令牌的本地进程可以直接调用这两条原生 RPC，设备令牌应只供该设备和专用目录账号使用。

| cs-agent 工具 | 控制机调用的原生接口 | 结果 |
| --- | --- | --- |
| `get_hostname` | `ProcessService/StartProcess`，命令由桥固定为 `hostname`，5 秒超时 | 校验正常退出后返回主机名 |
| `get_window_screenshot` | `DriverService/CallTool`，macOS Driver 按 PID 和窗口 ID 调用 `get_window_state`；随后调用 `list_windows` 按同一 PID 复核归属 | 返回单张 PNG，丢弃上游的窗口标题和其他文本 |

在管理台为 `cua` 重新检测并启用所需的 `get_hostname`、`get_window_screenshot`。主人在当前对话里选择这台设备；测试截图时还需给出专用测试窗口的 PID 和窗口 ID。设备的登录用户需要允许系统录制这个窗口。得到的 `structuredContent.imageId` 可用于本会话的 `send_message.images`。关闭窗口后重复请求应返回错误；Windows 设备目前只支持本节的主机名读取协议，Windows 真机验收待完成。

要恢复设备的目录模式，移除该回环站点的 `import owner-inspection`，校验后重新加载 Caddy。其余设备和原有的 Space ID 均沿用原配置。

## 撤销与轮换

先在管理台移除设备的所有会话分配，再从公网和目录两组 Caddy 路由移除该机并 reload，停止相应的 Relay 实例。使用运行目录 daemon 的账号清理控制机上的登记。以下示例仅移除第一台设备的本地目录条目。归档已使用的端口与 machine-id，后续设备分配全新组合。

```sh
sudo -u cua-directory env CUA_HOME=/var/lib/cs-agent-cua CUA_CREDENTIAL_STORE=file \
  CUA_TELEMETRY=0 CUA_MESH=off CUA_RELAY_URL=http://127.0.0.1:1 \
  /usr/local/bin/cua --daemon /run/cs-agent-cua/cua.sock spaces rm direct:127.0.0.1:18281
```

同一设备只轮换注册令牌时，更新它和控制机的两个注册文件并重启对应 Relay。设备令牌轮换后，重启设备端 join，并重新执行该设备的 register unit。轮换桥的 WSS 凭据后，重启桥，并在管理台核对和重新分配会话目录权限。
