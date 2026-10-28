#!/bin/sh
# magpie 网关容器入口（docs/WORKERS-DESIGN.md §3.7）：磁盘是临时的，状态从 R2 同步回来。
# 凭据只经环境变量进来（Workers 的 secrets → Container envVars），不落日志。
# 顺序：先起网关与回环中继，再打开同步。同步由网关进程执行，没有网关时 `s3 on` 会一直等；
# 另一份 magpie（主人的电脑）正在同步时它也会等锁，所以同步放后台，不挡服务。
set -u

/magpie serve &
gateway=$!
# Worker 经 3426 进来，中继转到回环的 3425：magpie 对回环来源不要求网关 key（见 relay.pl）
perl /relay.pl 0.0.0.0:3426 127.0.0.1:3425 &
relay=$!
trap 'kill -TERM "$gateway" "$relay" 2>/dev/null' TERM INT

if [ -n "${R2_BUCKET:-}" ]; then
  : "${R2_ENDPOINT:?R2_ENDPOINT 未设置}"
  : "${R2_ACCESS_KEY_ID:?R2_ACCESS_KEY_ID 未设置}"
  : "${R2_SECRET_ACCESS_KEY:?R2_SECRET_ACCESS_KEY 未设置}"
  : "${MAGPIE_SYNC_PASSPHRASE:?MAGPIE_SYNC_PASSPHRASE 未设置}"
  prefix="${R2_PREFIX:-magpie}"
  (
    sleep 3
    # secret 与 passphrase 按 magpie 的约定走 stdin 的前两行，不出现在命令行；打开即同步一次，取回桶里的 providers 与设置
    printf '%s\n%s\n' "$R2_SECRET_ACCESS_KEY" "$MAGPIE_SYNC_PASSPHRASE" \
      | /magpie s3 on "s3://$R2_BUCKET/$prefix" "access-key-id=$R2_ACCESS_KEY_ID" "endpoint=$R2_ENDPOINT" region=auto path-style=yes >/dev/null \
      || echo "magpie: 打开 R2 同步失败，网关以空配置运行" >&2
    /magpie s3 auto "${MAGPIE_SYNC_MINUTES:-3}" >/dev/null 2>&1 || true
  ) &
fi

wait "$gateway"
