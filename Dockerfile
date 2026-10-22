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
FROM node:24-bookworm-slim
RUN echo 'Acquire::Retries "8";' > /etc/apt/apt.conf.d/80retries \
 && apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates git tini bubblewrap \
 && rm -rf /var/lib/apt/lists/*

# comfy-cli + comfy-mcp（stdio MCP）装在独立 venv
RUN python3 -m venv /opt/comfy \
 && /opt/comfy/bin/pip install --no-cache-dir comfy-cli comfy-mcp

# codex CLI（固定版本）：常驻 app-server 的子 agent 唤醒（features.wake_on_agent_messages）自 0.164.0-alpha.8 起才有，
# 仍在开发中，升级前须按 docs/DESIGN-resident-agent.md §5.2 复测
RUN npm i -g @openai/codex@0.164.0-alpha.8 && npm cache clean --force

# codex 的浏览器 MCP：@playwright/mcp + headless Chromium（含系统依赖，需 root 安装；node 用户可读）
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
RUN npm i -g @playwright/mcp@0.0.83 \
 && node /usr/local/lib/node_modules/@playwright/mcp/node_modules/playwright/cli.js install --with-deps chromium \
 && chmod -R a+rX /opt/pw-browsers \
 && npm cache clean --force \
 && rm -rf /var/lib/apt/lists/* /tmp/*

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY workflows ./workflows
COPY scripts/entrypoint.sh /usr/local/bin/entrypoint.sh
# /etc/codex 归 node：入口脚本每次启动写入 requirements.toml（codex 命令沙箱的 deny_read 列表）
RUN sed -i 's/\r$//' /usr/local/bin/entrypoint.sh && chmod +x /usr/local/bin/entrypoint.sh \
 && mkdir -p /data /workspace /etc/codex && chown node:node /data /workspace /etc/codex

USER node
# 确认非 root 用户可执行系统 bwrap；命名空间实测需运行容器时使用 compose 的 seccomp profile。
RUN test -x /usr/bin/bwrap && /usr/bin/bwrap --version
# 关闭 comfy-cli 首次运行的交互式统计询问（否则会阻塞 MCP 子进程）
RUN /opt/comfy/bin/comfy --skip-prompt tracking disable || true

ENV NODE_ENV=production \
    DATA_DIR=/data \
    WORKSPACE_DIR=/workspace \
    COMFY_MCP_BIN=/opt/comfy/bin/comfy-mcp \
    COMFY_BIN=/opt/comfy/bin/comfy \
    CODEX_BIN=codex

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["tini", "--", "/usr/local/bin/entrypoint.sh"]
