#!/bin/sh
# 容器入口：准备 /data 目录，按环境变量重写受管的 codex config.toml，然后
#   - 带参数时执行该命令（例如 `docker compose run --rm cs-agent codex login --device-auth`）；
#   - 不带参数时启动 agent。
set -eu

DATA_DIR="${DATA_DIR:-/data}"
WORKSPACE_DIR="${WORKSPACE_DIR:-/workspace}"
CODEX_HOME_DIR="$DATA_DIR/codex"

# 卷必须可写：失败时给出明确提示（容器以 node 用户运行）
for dir in "$DATA_DIR" "$WORKSPACE_DIR"; do
  probe="$dir/.write-probe-$$"
  if ! { mkdir -p "$dir" && touch "$probe" && rm -f "$probe"; } 2>/dev/null; then
    echo "entrypoint: ERROR $dir is not writable by uid $(id -u) ($(id -un 2>/dev/null || echo '?')). Fix host permissions of the mounted volume (e.g. chown -R $(id -u):$(id -g) on the host directory)." >&2
    exit 1
  fi
done
mkdir -p "$CODEX_HOME_DIR" "$DATA_DIR/images"

# TOML 字符串值只允许安全字符，否则回退默认值
toml_value() {
  case "$1" in
    *[!A-Za-z0-9._-]*|"") echo "entrypoint: WARNING invalid value '$1' for $3, using '$2'" >&2; printf '%s' "$2" ;;
    *) printf '%s' "$1" ;;
  esac
}
MODEL="$(toml_value "${CODEX_MODEL:-gpt-6.1-sol}" gpt-6.1-sol CODEX_MODEL)"
EFFORT="$(toml_value "${CODEX_REASONING_EFFORT:-high}" high CODEX_REASONING_EFFORT)"

# config.toml 是受管文件：每次启动都按环境变量重写（先写临时文件再 mv，避免半截文件）
CONFIG="$CODEX_HOME_DIR/config.toml"
cat > "$CONFIG.tmp" <<TOML
# 受管文件：由 entrypoint.sh 在每次容器启动时按环境变量（CODEX_MODEL / CODEX_REASONING_EFFORT）重写。
# 不要手工修改——改动会在下次启动时被覆盖；请改 .env 后重启容器。不继承宿主机配置。
# model_reasoning_effort 只是默认值：cs-agent 每轮按请求以 -c model_reasoning_effort=... 覆盖。
model = "$MODEL"
model_reasoning_effort = "$EFFORT"

[mcp_servers]
TOML
mv -f "$CONFIG.tmp" "$CONFIG"

if [ ! -f "$CODEX_HOME_DIR/auth.json" ]; then
  echo "entrypoint: WARNING $CODEX_HOME_DIR/auth.json missing — run scripts/init-auth.ps1 on the host or 'docker compose run --rm cs-agent codex login --device-auth'" >&2
fi

export CODEX_HOME="$CODEX_HOME_DIR"

if [ "$#" -gt 0 ]; then
  exec "$@"
fi
exec node /app/dist/main.js
