# magpie 模型网关，跑在 Cloudflare Containers 上（docs/WORKERS-DESIGN.md §3.7）。
# 官方镜像自带 busybox shell 与静态链接的 /magpie，但没有 chmod，入口脚本用 COPY --chmod 带权限进来。
FROM ghcr.io/yetone/magpie:latest
COPY --chmod=0755 entrypoint.sh /entrypoint.sh
COPY --chmod=0644 relay.pl /relay.pl
EXPOSE 3426 3430
ENTRYPOINT ["/entrypoint.sh"]
