#!/usr/bin/env bash
# 把 Worker 需要的 secrets 从本地私有文件上传到 Cloudflare（wrangler secret bulk，值走 stdin，不进命令行与仓库）。
# 读取：仓库根 .env 的 NAPCAT_TOKEN、QQ_OWNER、QQ_ALLOW_USERS、QQ_ALLOW_GROUPS；secrets/r2-magpie.env 的 R2_*、MAGPIE_SYNC_PASSPHRASE。
# 用法：在仓库根执行  bash workers/scripts/put-secrets.sh
set -euo pipefail
# 在 worktree 里跑时 .env 与 secrets/ 只在主工作区，用 CS_AGENT_ROOT 指过去
workers_dir="$(cd "$(dirname "$0")/.." && pwd)"
root="${CS_AGENT_ROOT:-$(cd "$workers_dir/.." && pwd)}"
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
# 白名单是可选配置；缺项或空值都不影响必需 secrets 的上传。
QQ_ALLOW_USERS=$(read_var "$env_file" QQ_ALLOW_USERS || true)
QQ_ALLOW_GROUPS=$(read_var "$env_file" QQ_ALLOW_GROUPS || true)
R2_BUCKET=$(read_var "$r2_file" R2_BUCKET)
R2_ENDPOINT=$(read_var "$r2_file" R2_ENDPOINT)
R2_ACCESS_KEY_ID=$(read_var "$r2_file" R2_ACCESS_KEY_ID)
R2_SECRET_ACCESS_KEY=$(read_var "$r2_file" R2_SECRET_ACCESS_KEY)
MAGPIE_SYNC_PASSPHRASE=$(read_var "$r2_file" MAGPIE_SYNC_PASSPHRASE)
# 管理端点（记忆导入与 MCP 登录链接）的口令：没有就生成一次并存到 secrets/admin-token.env，之后沿用
admin_file="$root/secrets/admin-token.env"
if [ ! -f "$admin_file" ]; then
  printf 'ADMIN_TOKEN=%s
' "$(python -c 'import secrets; print(secrets.token_hex(24))')" > "$admin_file"
fi
ADMIN_TOKEN=$(read_var "$admin_file" ADMIN_TOKEN)

# 密钥只在本地私有目录生成一次；每次部署重建会导致已有 OAuth 密文无法解密。
oauth_file="$root/secrets/oauth-store-key.env"
if [ ! -f "$oauth_file" ]; then
  (umask 077; python -c 'import secrets,sys; from pathlib import Path; Path(sys.argv[1]).write_text("OAUTH_STORE_KEY=" + secrets.token_hex(32) + "\n", encoding="utf-8")' "$oauth_file")
fi
OAUTH_STORE_KEY=$(read_var "$oauth_file" OAUTH_STORE_KEY)
[[ "$OAUTH_STORE_KEY" =~ ^[0-9a-fA-F]{64}$ ]] || { echo "OAUTH_STORE_KEY 必须为 32 字节 hex" >&2; exit 1; }

for name in NAPCAT_TOKEN QQ_OWNER R2_BUCKET R2_ENDPOINT R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY MAGPIE_SYNC_PASSPHRASE ADMIN_TOKEN OAUTH_STORE_KEY; do
  [ -n "${!name}" ] || { echo "$name 为空" >&2; exit 1; }
done

# wrangler 的 OAuth 刷新要连 dash.cloudflare.com，网络不通时用 API token 直连 api.cloudflare.com：
# 把 token 放在 secrets/cloudflare-api-token.env（一行 CLOUDFLARE_API_TOKEN=...），存在就用它
token_file="$root/secrets/cloudflare-api-token.env"
if [ -z "${CLOUDFLARE_API_TOKEN:-}" ] && [ -f "$token_file" ]; then
  CLOUDFLARE_API_TOKEN=$(read_var "$token_file" CLOUDFLARE_API_TOKEN); export CLOUDFLARE_API_TOKEN
fi

cd "$workers_dir"
{
  printf '{'
  first=1
  for name in NAPCAT_TOKEN QQ_OWNER QQ_ALLOW_USERS QQ_ALLOW_GROUPS R2_BUCKET R2_ENDPOINT R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY MAGPIE_SYNC_PASSPHRASE ADMIN_TOKEN OAUTH_STORE_KEY; do
    [ -n "${!name}" ] || continue
    [ $first -eq 1 ] || printf ','
    first=0
    printf '"%s":%s' "$name" "$(printf '%s' "${!name}" | json_escape)"
  done
  printf '}\n'
} | npx wrangler secret bulk
echo "已上传必需 secrets 与非空 QQ 白名单到 Worker cs-agent"
