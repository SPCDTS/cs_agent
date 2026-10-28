#!/usr/bin/env bash
# 把 Worker 需要的 secrets 从本地私有文件上传到 Cloudflare（wrangler secret bulk，值走 stdin，不进命令行与仓库）。
# 读取：仓库根 .env 的 NAPCAT_TOKEN、QQ_OWNER；secrets/r2-magpie.env 的 R2_*、MAGPIE_SYNC_PASSPHRASE。
# 用法：在仓库根执行  bash workers/scripts/put-secrets.sh
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
env_file="$root/.env"; r2_file="$root/secrets/r2-magpie.env"
[ -f "$env_file" ] || { echo "缺少 $env_file" >&2; exit 1; }
[ -f "$r2_file" ] || { echo "缺少 $r2_file" >&2; exit 1; }

read_var() { # read_var <file> <NAME>：取第一处赋值，去掉引号与行尾注释
  local line; line=$(grep -E "^${2}=" "$1" | head -1 | cut -d= -f2-)
  line="${line%%#*}"; line="${line%\"}"; line="${line#\"}"; line="${line%\'}"; line="${line#\'}"
  printf '%s' "$(printf '%s' "$line" | sed -E 's/[[:space:]]+$//')"
}

json_escape() { python -c 'import json,sys; print(json.dumps(sys.stdin.read()))' ; }

NAPCAT_TOKEN=$(read_var "$env_file" NAPCAT_TOKEN)
QQ_OWNER=$(read_var "$env_file" QQ_OWNER)
R2_BUCKET=$(read_var "$r2_file" R2_BUCKET)
R2_ENDPOINT=$(read_var "$r2_file" R2_ENDPOINT)
R2_ACCESS_KEY_ID=$(read_var "$r2_file" R2_ACCESS_KEY_ID)
R2_SECRET_ACCESS_KEY=$(read_var "$r2_file" R2_SECRET_ACCESS_KEY)
MAGPIE_SYNC_PASSPHRASE=$(read_var "$r2_file" MAGPIE_SYNC_PASSPHRASE)
for name in NAPCAT_TOKEN QQ_OWNER R2_BUCKET R2_ENDPOINT R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY MAGPIE_SYNC_PASSPHRASE; do
  [ -n "${!name}" ] || { echo "$name 为空" >&2; exit 1; }
done

cd "$root/workers"
{
  printf '{'
  first=1
  for name in NAPCAT_TOKEN QQ_OWNER R2_BUCKET R2_ENDPOINT R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY MAGPIE_SYNC_PASSPHRASE; do
    [ $first -eq 1 ] || printf ','
    first=0
    printf '"%s":%s' "$name" "$(printf '%s' "${!name}" | json_escape)"
  done
  printf '}\n'
} | npx wrangler secret bulk
echo "已上传 7 个 secrets 到 Worker cs-agent"
