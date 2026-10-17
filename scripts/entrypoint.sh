#!/bin/sh
# 容器入口：准备 /data 目录与最小 codex config.toml，然后启动 agent。
set -eu

DATA_DIR="${DATA_DIR:-/data}"
CODEX_HOME_DIR="$DATA_DIR/codex"
mkdir -p "$CODEX_HOME_DIR" "$DATA_DIR/images" "${WORKSPACE_DIR:-/workspace}"

CONFIG="$CODEX_HOME_DIR/config.toml"
if [ ! -f "$CONFIG" ]; then
  cat > "$CONFIG" <<TOML
# 由 entrypoint.sh 生成；不继承宿主机配置。可手工修改，存在时不会被覆盖。
model = "${CODEX_MODEL:-gpt-6-astra}"
model_reasoning_effort = "${CODEX_REASONING_EFFORT:-high}"

[mcp_servers]
TOML
  echo "entrypoint: created $CONFIG" >&2
fi

if [ ! -f "$CODEX_HOME_DIR/auth.json" ]; then
  echo "entrypoint: WARNING $CODEX_HOME_DIR/auth.json missing — run scripts/init-auth.ps1 on the host or 'codex login --device-auth' in the container" >&2
fi

export CODEX_HOME="$CODEX_HOME_DIR"
exec node /app/dist/main.js
