# syntax=docker/dockerfile:1
# ---------- build: 编译 TypeScript，裁剪为生产依赖 ----------
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---------- runtime ----------
# 层顺序按变动频率从低到高：apt 基础包 → Playwright 系统依赖与 Chromium → 固定版本的 codex → 应用文件。
# apt 的 RUN 都挂 BuildKit 缓存（/var/cache/apt、/var/lib/apt）：已下载的 .deb 与索引跨构建保留，
# 不进入镜像层；为此先删掉基础镜像的 docker-clean（它会在每次 install 后清空下载缓存）。
FROM node:24-bookworm-slim
# apt 走国内镜像（deb.debian.org 在本机网络下常卡在拉索引）；可用 --build-arg APT_MIRROR=deb.debian.org 改回官方源。
# 后面 playwright install-deps 的 apt 也沿用这里改过的源。
ARG APT_MIRROR=mirrors.huaweicloud.com
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked --mount=type=cache,target=/var/lib/apt,sharing=locked \
    sed -i "s|deb.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list.d/debian.sources \
 && rm -f /etc/apt/apt.conf.d/docker-clean \
 && echo 'Binary::apt::APT::Keep-Downloaded-Packages "true";' > /etc/apt/apt.conf.d/keep-cache \
 && echo 'Acquire::Retries "8";' > /etc/apt/apt.conf.d/80retries \
 && apt-get update \
 && apt-get install -y --no-install-recommends python3 ca-certificates git tini bubblewrap

# codex 的浏览器 MCP：@playwright/mcp + headless Chromium（含系统依赖，需 root 安装；node 用户可读）
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
# 系统依赖单独装并重试：本机网络经代理访问镜像，长时间下载中途常断连；已下载的包留在 apt 缓存里，重试只补缺的。
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked --mount=type=cache,target=/var/lib/apt,sharing=locked \
    npm i -g @playwright/mcp@0.0.83 \
 && PW=/usr/local/lib/node_modules/@playwright/mcp/node_modules/playwright/cli.js \
 && for i in 1 2 3 4 5; do node "$PW" install-deps chromium && break; [ "$i" = 5 ] && exit 1; echo "install-deps 第 $i 次失败，重试"; sleep 10; done \
 && node "$PW" install chromium \
 && chmod -R a+rX /opt/pw-browsers \
 && npm cache clean --force \
 && rm -rf /tmp/*

# codex CLI（固定版本）：常驻 app-server 的子 agent 唤醒（features.wake_on_agent_messages）自 0.164.0-alpha.8 起才有，
# 仍在开发中，升级前须按 docs/ARCHITECTURE.md §4.3 的验证方法复测。
# 平台包（@openai/codex-linux-x64，约 100 MB）是可选依赖：经代理下载中途断开时 npm 静默跳过，装出的 codex 无法运行；
# 所以装完用 codex --version 校验，失败重试，最多 5 次仍失败则构建失败。
RUN for i in 1 2 3 4 5; do npm i -g @openai/codex@0.164.0-alpha.8 && codex --version && break; [ "$i" = 5 ] && exit 1; echo "codex 安装校验第 $i 次失败，重试"; sleep 10; done \
 && npm cache clean --force

ENV NODE_ENV=production \
    DATA_DIR=/data \
    WORKSPACE_DIR=/workspace \
    CODEX_BIN=codex

WORKDIR /app
# /etc/codex 归 node：入口脚本每次启动写入 requirements.toml（codex 命令沙箱的 deny_read 列表）
RUN mkdir -p /data /workspace /etc/codex && chown node:node /data /workspace /etc/codex
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY scripts/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN sed -i 's/\r$//' /usr/local/bin/entrypoint.sh && chmod +x /usr/local/bin/entrypoint.sh
COPY --from=build /app/dist ./dist

# 部署源码与编译产物来自同一构建上下文，node 只能读取。
ARG GIT_COMMIT=unknown
ARG BUILD_TIME=
ENV CS_AGENT_COMMIT=${GIT_COMMIT} CS_AGENT_BUILT_AT=${BUILD_TIME}
COPY src /app/source/src
COPY test /app/source/test
COPY docs /app/source/docs
COPY package.json tsconfig.json /app/source/
RUN printf 'commit=%s\nbuilt_at=%s\n' "$GIT_COMMIT" "$BUILD_TIME" > /app/source/COMMIT \
 && chown -R root:root /app/source && chmod -R a+rX,go-w /app/source

USER node
# 确认非 root 用户可执行系统 bwrap；命名空间实测需运行容器时使用 compose 的 seccomp profile。
RUN test -x /usr/bin/bwrap && /usr/bin/bwrap --version

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["tini", "--", "/usr/local/bin/entrypoint.sh"]
