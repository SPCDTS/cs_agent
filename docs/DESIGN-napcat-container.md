# NapCat 迁入容器（2026-10-19，用户决定）

用户原话："NapCat 你给我放容器里去，别在容器里用宿主机的 NapCat。"本文是实施约束；§6 记录验收。

## 0. 现状（已核实）

- 宿主机 NapCat 以 QQNT 注入方式运行（进程 `C:\Program Files\Tencent\QQNT\QQ.exe`，NapCat 目录 `D:\Tools\NapCat`），OneBot 配置 `D:\Tools\NapCat\config\onebot11_1670528780.json`：HTTP 服务 `127.0.0.1:3000`（`agent-http`）+ 正向 WebSocket `127.0.0.1:3001`（`agent-ws`），同一 token，`messagePostFormat=array`，`reportSelfMessage=false`，`enableForcePushEvent=true`，`enableLocalFile2Url=false`。
- cs-agent 通过 `NAPCAT_HTTP_URL=http://host.docker.internal:3000`（动作调用，Bearer token）与 `NAPCAT_WS_URL=ws://host.docker.internal:3001`（事件）连接；`NAPCAT_TOKEN` 在 `.env`。
- 官方镜像 `mlikiowa/napcat-docker`（linux/amd64、arm64）：entrypoint 用 `NAPCAT_UID/GID` 切换运行用户并 `chown /app`；`WEBUI_TOKEN` 只在 `config/webui.json` 不存在时初始化；`MODE=ws|reverse_ws|reverse_http` 只在 `config/onebot11.json` 不存在时从模板生成；`ACCOUNT` 设置后以 `-q <qq>` 快速登录。持久化卷：`/app/napcat/config`（NapCat 配置）、`/app/.config/QQ`（QQ 登录态与数据）。WebUI 端口 6099。镜像标签不与 NapCat 版本号对应（`v4.18.38` 无此标签），因此**按 digest 固定**。
- 同一 QQ 账号可在 Windows（宿主机 QQNT）与 Linux（容器 NapCat）同时在线，两边都会收到消息。迁移期间必须保证 cs-agent 只连一个，并在切换后停掉宿主机 NapCat，否则会双响应。

## 1. 目标形态

```
docker compose
├─ cs-agent   ── http://napcat:3000 / ws://napcat:3001 （compose 内网，不发布）
└─ napcat     ── 127.0.0.1:6099 WebUI（仅宿主机回环，扫码登录与配置）
                 卷 ./napcat/config → /app/napcat/config
                 卷 ./napcat/qq     → /app/.config/QQ
```

- NapCat 的 3000/3001 **不发布到宿主机**，只在 compose 网络内对 cs-agent 可见；监听地址在容器内为 `0.0.0.0`（compose 网络隔离即边界）。
- cs-agent 仍用 `host.docker.internal` 访问宿主机 ComfyUI 8188，不变。
- 宿主机 NapCat 停用（不卸载），作为回退手段保留一周后再清理。

## 2. 改动清单

| 文件 | 改法 |
|---|---|
| `docker-compose.yml` | 新增服务 `napcat`：`image: mlikiowa/napcat-docker@sha256:<digest>`（实施时 `docker buildx imagetools inspect mlikiowa/napcat-docker:latest` 取 index digest，写进注释标明对应日期）；`restart: unless-stopped`；`environment: NAPCAT_UID=1000, NAPCAT_GID=1000, WEBUI_TOKEN=${NAPCAT_WEBUI_TOKEN}`（不设 `MODE`，配置由我们自己播种；`ACCOUNT=${QQ_BOT_ACCOUNT:-}` 可选，默认空）；`ports: ["127.0.0.1:6099:6099"]`；卷见 §1；`mac_address` 固定（参考官方模板，避免 QQ 设备指纹变化触发重登）；`healthcheck`：`wget -qO- http://127.0.0.1:6099/ >/dev/null`。`cs-agent` 增加 `depends_on: napcat`（不用 `condition: service_healthy`，NapCat 未登录时 cs-agent 也应能起来并按现有重连逻辑等待）。 |
| `.env.example` / `.env` | `NAPCAT_HTTP_URL=http://napcat:3000`、`NAPCAT_WS_URL=ws://napcat:3001`（默认值在 `src/config.ts` 同步改）；新增 `NAPCAT_WEBUI_TOKEN`（WebUI 登录口令，随机生成）、`QQ_BOT_ACCOUNT=1670528780`（可选，供 `ACCOUNT` 快速登录）。`NAPCAT_TOKEN` 不变。 |
| `scripts/napcat-config.ps1`（宿主机运行，PowerShell 7 / 5.1 均可） | 幂等播种 `./napcat/config/onebot11.json` 与 `./napcat/config/onebot11_<QQ_BOT_ACCOUNT>.json`：从 `.env` 读 `NAPCAT_TOKEN`，写入与 §0 相同结构的配置（httpServers `0.0.0.0:3000` + websocketServers `0.0.0.0:3001`，同 token，`array` 格式、`reportSelfMessage=false`、`enableForcePushEvent=true`、`heartInterval=30000`、`enableLocalFile2Url=false`、`timeout` 段照抄宿主机值）。已存在且 token 一致则不动；token 不一致则只更新 token 字段并备份原文件。目录不存在时创建；Windows 下目录权限不需要处理（Docker Desktop 卷由 VM 映射）。 |
| `.gitignore` | 加 `napcat/`（含登录态，绝不入库）。 |
| `src/config.ts` | `NAPCAT_HTTP_URL` / `NAPCAT_WS_URL` 默认值改为 `http://napcat:3000` / `ws://napcat:3001`；`serviceUrl` 校验保持（允许 `napcat` 这种无点主机名——检查现有 zod 规则是否要求带点）。 |
| `docs/DEPLOY.md` | 新章节"NapCat 容器"：首次登录流程、回退到宿主机 NapCat 的方法、更新镜像（改 digest）、数据目录说明；删除/改写"宿主机 NapCat 3000/3001"的描述；端口表更新。 |
| `docs/ARCHITECTURE.md` §2、§7 | 外部依赖与 Docker 结构更新。 |
| `test/` | `config.test.ts` 默认值断言更新；新增 `test/napcat-config.test.ts`：用 pwsh 跑播种脚本（有 pwsh 时）验证生成的 JSON 结构、token 注入与幂等（无 pwsh 时跳过并说明）。 |

不改 `src/qq/*` 的任何逻辑：OneBot 协议、事件格式、图片 URL 下载路径不变（NapCat 事件里的图片 `url` 仍是腾讯 CDN，cs-agent 直接下载）。

## 3. 迁移步骤（主会话执行，用户只做扫码）

1. 合入代码，生成 `NAPCAT_WEBUI_TOKEN` 写入 `.env`，运行 `scripts/napcat-config.ps1` 播种配置。
2. `docker compose up -d napcat`（只起 NapCat），`docker compose logs -f napcat` 看到 WebUI 就绪。
3. **用户**打开 `http://127.0.0.1:6099/webui`，用 `NAPCAT_WEBUI_TOKEN` 登录，扫码登录机器人账号 1670528780（或设置 `QQ_BOT_ACCOUNT` 后由 `ACCOUNT` 快速登录，仍需首次扫码）。此时宿主机 NapCat 仍在线，cs-agent 仍连宿主机，服务不中断。
4. 主会话在 WebUI/日志确认容器 NapCat 在线；在容器网络内 `curl http://napcat:3000/get_login_info`（带 token）确认返回机器人 QQ。
5. **先停宿主机 NapCat**（退出 QQNT 或停掉 NapCat 的启动项），再把 `.env` 切到 `napcat:3000/3001`，`docker compose up -d cs-agent`。顺序不能反，避免两个在线端同时回复。
6. 用户发一条私聊验证收发；观测面板 `/live` 看到事件；`docs/DESIGN-napcat-container.md` §6 记录。
7. 一周后无问题，把宿主机 NapCat 的自启动项移除（用户决定）。

回退：`.env` 改回 `host.docker.internal`，`docker compose up -d cs-agent`，重启宿主机 NapCat；容器 NapCat `docker compose stop napcat`。

## 4. 与其他改动的关系

- `docs/DESIGN-attachments.md`（附件发送）：传输仍用 `base64://`，不依赖共享卷，与本迁移无耦合；两者可独立部署，顺序不限。
- 包结构整理 P1/P2：本迁移不碰 `src/qq/*` 逻辑，只改 `config.ts` 两个默认值，冲突面极小；可在 P1 合入后立即做。
- 实施交 Codex 子代理（compose、脚本、config 默认值、测试、文档）；迁移步骤由主会话执行，扫码由用户完成。

## 5. 非目标

- 不做 NapCat 反向连接（reverse ws/http）；不发布 3000/3001 到宿主机；不把 NapCat 的 HTTP 换成 SSE。
- 不迁移宿主机 NapCat 的历史数据（聊天记录在 cs-agent 自己的 qq-messages.sqlite 里，不依赖 NapCat）。

## 6. 验收记录

（待填）
