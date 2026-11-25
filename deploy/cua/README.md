# Cua 设备目录与执行部署

这套模板让 cs-agent 通过反向桥读取已登记设备及其 Driver 工具清单，并按设备开放通用 Shell、后台长任务（Linux/macOS）、文本写文件与完整 Driver 桌面操作。启用后，主人及获分配该设备的会话和获授权子任务均可在授权范围内直接执行这些操作。控制机需有 Linux、支持 `LoadCredential` 的 systemd、Caddy 2 和 Node.js 24。上游 `cua-sdk-v0.31.0` 对应的 CLI 与 daemon 为 0.31.0，同一提交的 `cua-relay` 和设备端 `cua-spacesd` 为 0.17.2。示例域名和机器 ID 需按本次接入填写。[Cua 固定版本](https://github.com/trycua/cua/tree/78fe31378569aab57ddb5131a08fc90fc3c6fbb9) [spacesd 版本](https://github.com/trycua/cua/blob/78fe31378569aab57ddb5131a08fc90fc3c6fbb9/libs/cua-spacesd/VERSION)

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
5. 在 cs-agent「权限与运维 → Cua 设备分配」输入 VPS 桥令牌，点「启用 Cua」。「模型与接入 → MCP 与设备」也有「Cua 服务与设备分配」入口。首次可用密码管理器生成 64 个随机十六进制字符。管理台会登记 `cua`、保存加密凭据并显示该桥的 WSS 地址。此时可关闭页面，启用请求已经保存。
6. 在 VPS 把页面上的 WSS 地址和同一枚令牌写入 `/etc/cs-agent/cua/bridge.env`，格式如下，再运行 `systemctl enable --now cua-directory-bridge`。桥连接后 cs-agent 自动检测并启用下表的执行工具以及 `list_spaces`、`list_tools`。首次握手失败会在重连时或五分钟内重试。需要自选工具或只读限制的管理员可使用原有的「接入或管理远程 MCP 服务」手工配置。

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

## 管理台添加设备

VPS 首次启用管理台配对后，管理员只需在「权限与运维 → Cua 设备分配」选择 macOS 或 Windows x64，点「添加设备」，把命令私下交给设备用户。用户在 Mac 终端或 Windows PowerShell 运行命令，保持窗口打开，管理员刷新设备列表即可按主机名分配会话。命令仅下载固定版本的原生客户端并核对 SHA-256，使用当前用户身份运行。Windows 使用组织允许的 PowerShell 脚本执行策略。

配对码由 cs-agent 签发，十分钟内可在一台设备上兑换。VPS 在兑换时创建该设备专属的两枚随机凭据。设备通过 HTTPS 领取凭据，之后始终使用原生 `cua-spacesd join` 连接 Relay。重复执行同一命令可以恢复传输失败的领取。连接成功后可用终端给出的本机命令重连，配对码到期也不影响重连。Mac 的本地文件位于 `~/Library/Application Support/cs-agent/cua/`，Windows 文件位于 `%LOCALAPPDATA%\cs-agent\cua\`。

### 首次配置 VPS 配对入口

1. 安装本版本的反向桥 bundle 和 `cua-directory-bridge.service`，按「安装控制机」部署原生 `/usr/local/bin/cua`、`/usr/local/bin/cua-relay` 与目录 daemon。旧版本的反向桥仍可供既有设备使用，管理台签发时会提示升级。
2. 以下命令在 VPS 上生成 Caddy 的三个配置片段。先确认 19101–19108 和 19201–19208 这两段回环端口没有其他用途，并为此目录保留它们。

   ```sh
   install -d -m 0755 /etc/caddy/cua-pair
   for section in servers join directory; do
     node /opt/cs-agent/cua/reverse-mcp-bridge.cjs --print-pair-caddy "$section" > "/etc/caddy/cua-pair/$section.caddy"
   done
   ```
3. 在 Caddyfile 全局选项的花括号内加入 `import /etc/caddy/cua-pair/servers.caddy`。在 Relay 公网站点的兜底 `handle` 前加入 `import /etc/caddy/cua-pair/join.caddy`。在所有站点之外加入 `import /etc/caddy/cua-pair/directory.caddy`。三个文件复用本仓库 Caddyfile 中的 `(join)` 和 `(directory)` 定义，升级旧配置时先补齐这两个片段。校验并重载 Caddy，沿用既有证书策略和 443/TCP 入口。
4. 将 `CUA_PAIR_RELAY_URL=wss://relay.example.org` 加入原有的 `/etc/cs-agent/cua/bridge.env`（换成实际域名）。执行 `systemctl daemon-reload` 和 `systemctl restart cua-directory-bridge`。此后只有实际兑换的设备才启动原生 Relay。桥进程以 `cua-directory` 身份写入专用状态，在设备握手成功后调用原生 `cua spaces add`。

默认预留 8 个名额。扩大容量时，可在生成三个配置片段的命令环境和桥的环境文件中设置相同的 `CUA_PAIR_CAPACITY`，如 `16`。每个端口段最多容纳 100 台，扩容前检查新增端口是否空闲，重新生成片段、重载 Caddy 并重启桥，保留既有槽位。每台设备独占固定的 Relay 和回环目录端口。默认只开放设备发现和 Driver 工具查询。按下文「为设备启用执行能力」在目标设备的回环站点显式添加执行路由。请备份权限为 0700 的 `/var/lib/cs-agent-cua-pairing` 目录及 Cua 目录状态。已分配的端口永久保留，恢复备份时应与已有分配使用同一组身份。若丢失身份数据，应先停用配对、轮换桥凭据使旧分配失效，再重建。退役单台配对设备时先撤销会话分配，在其 `paired-N` 状态目录内创建空的 `retired` 文件，桥会停止该 Relay。再按「撤销与轮换」移除目录条目，保留槽位目录防止旧授权漂移。

## 手动登记一台设备

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

## 为设备启用执行能力（Shell、后台任务、写文件与完整桌面）

在目标设备已用独立设备令牌完成登记后，修改控制机 Caddyfile 中该设备现有的回环站点，导入 `(device-execution)` 放行执行与写文件所需的 gRPC 路径（仍仅监听 `127.0.0.1`）。以下配置对应表中的工作用 Mac，两条 `import` 必须使用同一台设备的 machine-id 和 Relay 端口。**沿用旧模板时，务必将片段定义与已启用的 `import owner-inspection` 或 `import device-inspection` 更名为 `import device-execution`**：

```caddyfile
http://127.0.0.1:18281 {
	import device-execution computer-alpha 18181
	import directory computer-alpha 18181
}
```

用 `caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile` 检查后重新加载配置，并核对 `ss -ltn` 中该端口仅监听 `127.0.0.1`。公网入口继续只在 443/TCP 接受指定机器的 join。Caddy 在回环路径上放行 `ProcessService/{StartProcess,ConnectProcess,SignalProcess}`、`FilesystemService/{WriteFile,BeginUpload,UploadChunk,CommitUpload,AbortUpload}` 与 `DriverService/CallTool`，并将请求的设备 Bearer 交给该机的 spacesd 验证。设备端需使用 `--token-file`。掌握设备令牌的本地进程可以直接调用这些原生 RPC，设备令牌应只供该设备和专用目录账号使用。

| Cua MCP 工具 | 转发的原生动作与主要边界 | 说明 |
| --- | --- | --- |
| `space_bash` | 在设备运行任意 Shell 命令（Linux/macOS `/bin/sh -c`，Windows `cmd.exe /C`），默认 30s、最长 50s | `timeout` 在 bridge/Worker 内强限 1–50s；超长命令请改用 `space_job` |
| `space_job` | 后台长任务管理（`start`/`status`/`logs`/`cancel`/`list`） | **上游仅支持 Linux/macOS**（Windows 由上游拒绝）；已移除跨线程通知参数 `notify`/`wake` |
| `space_write` | 原子写文本到指定绝对路径并自动创建父目录（底层走 `FilesystemService` 上传） | 单次 `content` UTF-8 ≤ 256 KiB |
| `call_tool` | 透传 `service="driver"` 的完整桌面工具与参数（查询、截图、点击、键入、窗口控制等） | 返回的截图（PNG/JPEG/WebP/GIF）经魔数校验并自动存入当前会话媒体库，给出 `imageId`/`imageIds` |

先在管理台核对已获分配的群聊和私聊，再为 `cua` **重新检测（probe）并启用**所需工具。如果从仅开放目录/只读窗口的旧版本升级，未重新检测直接启用 `space_bash` 或完整 `call_tool` 会返回 `probe_required`。重新检测新契约后启用即可；管理员也可随时为 `call_tool` 勾选「仅允许只读桌面查询」或为 `space_job` 勾选「仅允许查询后台任务」，将已有授权收紧回只读模式（并自动使旧子任务快照失效）。被动事件、跨会话 `agent` 回合及定时任务不可调用上述设备工具。

为保护控制机（VPS）本地文件系统与系统安全，反向桥刻意拒绝宿主与设备之间搬运 VPS 本地文件的工具（`upload`、`download`、`send_file`）。要回退某台设备回目录模式，只需移除该回环站点的 `import device-execution`，校验并重载 Caddy。

## 临时 Space 的供应边界（仍不向模型开放 `create_space` / `delete_space`）

在开放设备 Shell、文件与桌面操作时，请务必将控制机目录 daemon 的 Unix socket 和供应凭据保留在专用服务账号下。拥有这些凭据的操作系统账号可以直接使用 Cua 管理资源。

本部署继续将 Space 的创建和销毁留在控制端人工管理（反向桥与 Worker 均拒绝 `create_space`、`delete_space` 等生命周期工具），原因如下：Cua 0.31.0 用 `local:<名称>` 标识本机实例，同名重建后 ID 可以复用；原生 MCP 的 `delete_space` 只接收 `space`，会递归删除子 Space。即便 cs-agent 记下本会话创建过哪个 ID，稍后删除也可能命中同名的新实例或其他会话的子 Space。此外本机 `create_space.timeout` 仅限制等待就绪的时长，设置到期删除需要额外一步，若控制机在两步之间中断，实例可能持续运行。[本机 Space ID](https://github.com/trycua/cua/blob/78fe31378569aab57ddb5131a08fc90fc3c6fbb9/libs/cua/crates/cua-spaces/src/id.rs#L70-L90) [原生 MCP 删除参数](https://github.com/trycua/cua/blob/78fe31378569aab57ddb5131a08fc90fc3c6fbb9/libs/cua/crates/cua-spaces/src/mcp/tools.rs#L363-L366) [子树删除逻辑](https://github.com/trycua/cua/blob/78fe31378569aab57ddb5131a08fc90fc3c6fbb9/libs/cua/crates/cua-spaces/src/tree.rs#L235-L275) [本机创建参数](https://github.com/trycua/cua/blob/78fe31378569aab57ddb5131a08fc90fc3c6fbb9/libs/cua/crates/cua-spaces/src/spaces.rs#L3318-L3347) [设置 Space 到期时间](https://github.com/trycua/cua/blob/78fe31378569aab57ddb5131a08fc90fc3c6fbb9/libs/cua/crates/cua-spaces/src/lifetimes.rs#L115-L157)

## 撤销与轮换

先在管理台移除设备的所有会话分配，再从公网和目录两组 Caddy 路由移除该机并 reload，停止相应的 Relay 实例。使用运行目录 daemon 的账号清理控制机上的登记。以下示例仅移除第一台设备的本地目录条目。归档已使用的端口与 machine-id，后续设备分配全新组合。

```sh
sudo -u cua-directory env CUA_HOME=/var/lib/cs-agent-cua CUA_CREDENTIAL_STORE=file \
  CUA_TELEMETRY=0 CUA_MESH=off CUA_RELAY_URL=http://127.0.0.1:1 \
  /usr/local/bin/cua --daemon /run/cs-agent-cua/cua.sock spaces rm direct:127.0.0.1:18281
```

同一设备只轮换注册令牌时，更新设备和控制机的注册文件并重启对应 Relay。设备令牌轮换后，重启设备端 join，并重新执行该设备的 register unit。在管理台暂停 `cua` 服务会保留已有设备分配，暂停期间仍可撤回分配。轮换桥的 WSS 凭据会清空原分配。更新控制机桥凭据、重启并核对连接后，按完整 Space ID 重新向所需会话分配设备。
