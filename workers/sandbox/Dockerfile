# 原生 Container 执行命令，官方 Files 通过同版本 sandbox-shim 操作文件。
FROM node:24-trixie-slim
COPY --from=docker.io/cloudflare/sandbox:1.0.3 /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git python3 \
 && rm -rf /var/lib/apt/lists/* \
 && usermod --login sandbox --home /home/sandbox --move-home --shell /bin/bash node \
 && groupmod --new-name sandbox node \
 && mkdir -p /work/out && chown -R sandbox:sandbox /work
COPY --chmod=0644 runtime.mjs workspace.mjs /opt/sandbox/
WORKDIR /work
CMD ["sleep", "infinity"]
