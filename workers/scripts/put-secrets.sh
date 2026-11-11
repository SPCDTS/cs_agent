#!/usr/bin/env bash
# 把 Worker 需要的 secrets 从本地私有文件上传到 Cloudflare（wrangler secret bulk，值走 stdin，不进命令行与仓库）。
# 读取：仓库根 .env 的 NAPCAT_TOKEN、QQ_OWNER、QQ_ALLOW_USERS、QQ_ALLOW_GROUPS、DEEPSEEK_APIKEY（上传为 DEEPSEEK_API_KEY，可选）；
# secrets/gmail/client.json 与 token.json（可选）的 GMAIL_CLIENT_ID、GMAIL_CLIENT_SECRET、GMAIL_REFRESH_TOKEN；
# secrets/admin-token.env、oauth-store-key.env 不存在时就地生成。ChatGPT 订阅不走 secrets，在管理面板登录。
# 用法：在仓库根执行  bash workers/scripts/put-secrets.sh deployments/<档案>.json
set -euo pipefail
# 在 worktree 里跑时 .env 与 secrets/ 只在主工作区，用 CS_AGENT_ROOT 指过去
workers_dir="$(cd "$(dirname "$0")/.." && pwd)"
root="${CS_AGENT_ROOT:-$(cd "$workers_dir/.." && pwd)}"
profile="${1:?请显式提供 deployments/<档案>.json}"
(cd "$workers_dir" && node scripts/deploy.mjs "$profile" --prepare-only)
env_file="$root/.env"
[ -f "$env_file" ] || { echo "缺少 $env_file" >&2; exit 1; }

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
# DeepSeek 直连的 key；为空时不上传，面板里 DeepSeek 显示缺 key，仍可选 ChatGPT 订阅
DEEPSEEK_API_KEY=$(read_var "$env_file" DEEPSEEK_APIKEY || true)
[ -n "$DEEPSEEK_API_KEY" ] || echo ".env 里没有 DEEPSEEK_APIKEY，跳过 DEEPSEEK_API_KEY" >&2
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


# Gmail：桌面客户端 JSON 与 owner 授权后的 token.json（client.json 使用 installed/client_id/client_secret，token.json 使用 refresh_token）。可选，任一缺失就跳过三项
json_field() { python -c 'import json,sys
value = json.load(open(sys.argv[1], encoding="utf-8"))
for key in sys.argv[2:]: value = value[key]
print(value if isinstance(value, str) else "", end="")' "$@" 2>/dev/null || true; }
gmail_dir="$root/secrets/gmail"
GMAIL_CLIENT_ID=$(json_field "$gmail_dir/client.json" installed client_id)
GMAIL_CLIENT_SECRET=$(json_field "$gmail_dir/client.json" installed client_secret)
GMAIL_REFRESH_TOKEN=$(json_field "$gmail_dir/token.json" refresh_token)
if [ -z "$GMAIL_CLIENT_ID" ] || [ -z "$GMAIL_CLIENT_SECRET" ] || [ -z "$GMAIL_REFRESH_TOKEN" ]; then
  echo "secrets/gmail 下的 client.json 或 token.json 不完整，跳过 GMAIL_* secrets" >&2
  GMAIL_CLIENT_ID=""; GMAIL_CLIENT_SECRET=""; GMAIL_REFRESH_TOKEN=""
fi

# Workshop MCP 使用完整 Authorization 头；只有本机配置存在时才上传。
CS2_WORKSHOP_AUTHORIZATION=""
workshop_token_file="$root/secrets/workshop/mcp-token.txt"
if [ -f "$workshop_token_file" ]; then
  workshop_token=$(python -c 'from pathlib import Path; import sys; print(Path(sys.argv[1]).read_text(encoding="utf-8").strip(), end="")' "$workshop_token_file")
  [ -z "$workshop_token" ] || CS2_WORKSHOP_AUTHORIZATION="Bearer $workshop_token"
fi

for name in NAPCAT_TOKEN QQ_OWNER ADMIN_TOKEN OAUTH_STORE_KEY; do
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
  for name in NAPCAT_TOKEN QQ_OWNER QQ_ALLOW_USERS QQ_ALLOW_GROUPS DEEPSEEK_API_KEY ADMIN_TOKEN OAUTH_STORE_KEY GMAIL_CLIENT_ID GMAIL_CLIENT_SECRET GMAIL_REFRESH_TOKEN CS2_WORKSHOP_AUTHORIZATION; do
    [ -n "${!name}" ] || continue
    [ $first -eq 1 ] || printf ','
    first=0
    printf '"%s":%s' "$name" "$(printf '%s' "${!name}" | json_escape)"
  done
  printf '}\n'
} | npx wrangler secret bulk --config wrangler.deploy.json
echo "已上传必需 secrets、非空 QQ 白名单、DeepSeek key（如有）、可用的 Gmail 与 Workshop 凭据到显式选定的 Worker"
