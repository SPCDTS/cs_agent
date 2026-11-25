# 个人设备与持久 VM 的 Cua 接入

**接入新设备**　管理员在「权限与运维 → Cua 设备分配」选择系统并点「添加设备」，把生成的命令交给设备用户在 Mac 终端或 Windows PowerShell 运行。刷新设备列表后即可分配给会话。VPS 首次需要安装配对组件，后续新增设备均可在管理台操作。[设备配对与 VPS 首次配置](../deploy/cua/README.md#管理台添加设备)

cs-agent 通过名为 `cua` 的反向 MCP 访问自托管的 Cua Spaces。设备卡给出名称、完整 Space ID、系统和上游报告的状态。设备卡名称默认采用 Cua 握手时读到的系统主机名。主人可在管理台设置中文或其他显示名，清空后恢复默认名称；改名不影响已有分配。模型先用 `list_spaces` 找到设备，再在后续调用中传回同一张卡的完整 ID。

| 工具 | 参数与结果 | 谁可以调用 |
| --- | --- | --- |
| `list_spaces` | 返回当前会话可见的设备卡 | 主人及获分配设备的会话 |
| `list_tools` | 传入 `space` 和 `service=driver`，可用 `name` 筛选 Driver 工具并查看参数契约 | 同上 |
| `space_bash` | 传入 `space`、任意 Shell `command` 及可选 `timeout`（默认 30s，最长 50s） | 主人、已获设备分配的群聊或私聊，以及在该授权范围内派出的子任务 |
| `space_job` | 传入 `space` 和 `action`（`start`/`status`/`logs`/`cancel`/`list`），在 Linux/macOS 后台运行长耗时任务（不含跨线程 `notify`/`wake`）；Windows 会由上游拒绝 | 同上 |
| `space_write` | 传入 `space`、目标绝对路径 `path` 与文本 `content`（单次 UTF-8 ≤ 256 KiB），原子覆盖写入并创建父目录 | 同上 |
| `call_tool` | 传入 `space`、`service=driver`、Driver 工具名 `tool` 与 `arguments`。支持完整桌面查询与输入操作；返回图片会自动写入当前会话媒体库并附带 `structuredContent.imageId` / `imageIds` | 同上 |

后四项沿用 Cua 原生工具名。在控制机为目标设备启用执行路由后，还需在管理台重新检测并启用对应工具。管理员可在管理台为 `call_tool` 勾选「仅允许只读桌面查询」、为 `space_job` 勾选「仅允许查询后台任务」，从而把对应工具收敛为只读（`list_spaces` 与 `list_tools` 固定只读，`space_bash` 与 `space_write` 固定读写执行）。已获分配设备列表内的会话（群聊或外部私聊）及其在有效快照范围内的子任务可**免审直接使用**上述已启用工具；定时任务、被动事件及跨会话 `agent` 回合均不可调用。

为避免把控制机（VPS）本地文件系统暴露给会话或触发上游 `local:<name>` 同名复用与递归删除子树风险，反向桥刻意不向模型开放宿主传文件工具（`upload`、`download`、`send_file`）及原生生命周期工具（`create_space`、`delete_space`、`remove_space`、`add_space` 等）。设备端回复图片时，可将结果中的 `structuredContent.imageId` 放入 `send_message.images` 回传聊天窗口。遇到执行结果未知（`outcome_unknown`），先通过查询状态确认再决定下一步，切勿盲目重复写操作。

## 控制端与设备

| 位置 | 职责 |
| --- | --- |
| Cloudflare Worker | 托管对话、操作权限、MCP 工具目录与结果。现有反向 WebSocket 接受经过认证的 MCP 节点，管理台可查看注册节点的连接状态。 |
| 自建 VPS | 运行 Static Mode Relay 和聚合 `cua daemon`。控制端保存每台设备的目录和独立凭据。聚合 MCP 仅供 VPS 本地访问，反向桥负责连接 Worker。 |
| Mac、Linux、Windows VM | 在设备侧运行 Cua 的设备服务和所需的 Driver。Windows 持久 VM 使用来宾内的交互用户。桌面可用性取决于用户登录状态和本机授予的权限。 |

静态模式需要核对设备身份。Cua SDK 0.31.0 按主机名和端口构造 `direct:<host:port>`。同一 Relay 的多个 URL 即便路径含有不同 machine ID，在聚合目录里仍可能得到同一个 ID，后登记的设备可能覆盖原端点。每台设备需要独立且稳定的内部主机名或端口，并将该地址和允许注册的设备身份绑定。换机时先撤回原分配，核对新设备身份后再授权。[Cua 0.31.0 的设备登记实现](https://github.com/trycua/cua/blob/cua-sdk-v0.31.0/libs/cua/crates/cua-spaces/src/spaces.rs#L1322-L1382)

公网入口只接受所需的设备注册流量。设备代理路径 `/m/<machine-id>/…` 和聚合 MCP 仅能从内部访问。设备与控制端凭据分开保存，按各自身份鉴权。管理台中的「节点在线」表示反向桥已连接 Worker。设备状态和 Driver 工具目录要从对应的 Space 查询。安装步骤、按设备分配端口的示例和凭据轮换方式见[控制机部署指南](../deploy/cua/README.md)。

## 会话分配与生产验收

首次配置时，在「权限与运维 → Cua 设备分配」输入 VPS 桥令牌并点「启用 Cua」。页面会显示 VPS 应连接的 WSS 地址。桥使用同一枚令牌连回后，cs-agent 自动检测并启用设备工具。设备端登记及 VPS 配置见[部署指南](../deploy/cua/README.md#安装控制机)。

主人在「权限与运维」的「设备按会话分配（Cua）」为指定的 `group:<id>` 或 `private:<id>` 勾选设备。主人可使用全部设备，其他会话的所有已启用 Cua 工具均仅限获分配的设备并免审直接执行；管理员可通过「仅允许只读桌面查询」和「仅允许查询后台任务」分别限制 `call_tool` 与 `space_job` 的写操作。子任务可用的设备取派出时清单与当前分配的交集。撤销后重新分配同一台设备时，须重新派发子任务。普通第三方 MCP 与 WSB 的授权独立配置。

上线前使用两个可区分的设备身份验收目录、执行与隔离。每个身份使用各自的注册令牌、设备令牌、Relay 和目录端口。协议回归可用返回不同执行结果的探针，真实 Shell/写文件/桌面操作以真实设备核验：

1. 在纯自托管配置下，确认控制端和设备都能运行。重启其中一台后核对两台的稳定 ID 和实际主机名，再核对旧身份无法接管新分配。
2. 在主人会话列出两台设备的名称、系统和完整 ID，分别查询 Driver 清单并核对响应来自选定设备。到已启用 `(device-execution)` 的测试 Mac 上依次验证 `space_bash` 执行命令、`space_write` 写入文件、`space_job` 启动并轮询日志，以及 `call_tool` 执行桌面截图/交互并确认截图自动保存 `imageId` 可回传会话；确认 `create_space`/`delete_space` 与 `upload`/`download` 继续拒绝。
3. 仅向一个测试会话分配设备 B。核对会话与该会话派出的子任务均可在 B 上免审执行已启用的 `space_bash`/`space_job`/`space_write`/`call_tool`，指定未分配的 A 被拒。派发子任务后撤销 B，再核对其下一次调用被拒。
4. 暂停 `cua`，核对分配仍在、设备调用被拒、管理员仍可撤回。恢复并重新查询。轮换桥凭据后，核对旧分配已清空，再按完整 ID 分配并验证访问。最后复查普通 MCP、QQ 收发及 WSB。

公网 443 上的自托管 Relay 已用临时设备验过注册、目录查询和重连；按本轮约定，Windows 真机验收延后由仓库主人现场确认，生产切换时仍须先完成目标 Worker 的实测与旧入口清理。

## 从旧设备服务切换

合并到 `main` 会触发生产部署。新版 Registry 首次初始化会删除旧配对表、工具别名，以及能与配对记录或旧桌面工具契约匹配的 MCP 记录。届时旧管理台将失去按设备撤销 Tunnel 的入口。由生产操作者在约定的切换窗口执行以下清单，先核销旧入口，再合并。

| 时点 | 操作与完成判据 |
| --- | --- |
| 切换前盘点 | 暂停新增旧配对，结束或迁移旧任务。私下记录每项旧服务的设备名、UUID、MCP 地址、实际使用方、Tunnel ID、DNS 记录及专用凭据的归属。检查手工改名或改址的服务、定时任务和自定义技能。旧版已有同名 `cua` 服务时，先用其他 ID 重新配置它。保存需保留的收据；若要求原样回退，先取得可恢复的旧 Registry 备份。 |
| 合并前撤销 | 保持旧 Worker 与连接器运行，在旧管理台逐台点「撤销接入」。该操作禁用对应 MCP 并把 Tunnel 入口改为返回 404。复查 Cloudflare 上该 Tunnel 的 ingress，并在连接器在线时请求原 MCP 路径确认 404。写配置失败时点「重试关闭入口」。已离线或已先升级的设备，按盘点清单在 Cloudflare 核实并关闭对应路由。归属未明或未关闭的入口记为待办，先暂停切换。 |
| 停用旧组件 | 在设备上以原登录账户运行 `node cs-agent-device.cjs remove-service`，自定义状态目录加原 `--state-dir`。停止手工启动的进程，按实际安装情况停用 `CsAgentDesktopMcp`、`CsAgentHypervShellV1`、`CsAgentHypervDesktopV1` 计划任务。逐项删除旧设备专用 DNS、Tunnel，撤销专用凭据并记录结果。逐一核对仍服务于 CS2 Workshop、WSB 或账户管理的共享配置，保留持久 VM 磁盘和 WSB 任务账本。 |
| 切换与复核 | 确认旧入口均已核销、控制机就绪后再合并。部署完成后为反向目录桥重新登记保留 ID `cua`，重新接入设备，按完整 Space ID 恢复所需分配。验证上节的会话行为并复查旧 MCP 及其路由、第三方 MCP、WSB 和 QQ。记录未完成项目及负责人。 |

切换前撤销过的设备需要重新登记才能恢复接入。单独回退 Worker 无法还原已删除的配对表、已撤销的凭据或已删除的 Cloudflare 资源。
