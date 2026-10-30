# coding 工具的沙箱容器，由 SandboxDO 经 ctx.container.start() 按需拉起（docs/WORKERS-DESIGN.md §3.5）。
# 不用官方 cloudflare/sandbox 镜像：1.x 起它只带 sandbox-shim，文件操作要经 @cloudflare/sandbox 的帧协议，
# 这里换成一个小的 HTTP 控制服务（server.mjs），Worker 侧不需要额外依赖。
FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git nodejs python3 \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --uid 1000 --shell /bin/bash sandbox \
 && mkdir -p /work/out && chown -R sandbox:sandbox /work
COPY --chmod=0644 server.mjs workspace.mjs /opt/sandbox/
WORKDIR /work
EXPOSE 3000
CMD ["node", "/opt/sandbox/server.mjs"]
