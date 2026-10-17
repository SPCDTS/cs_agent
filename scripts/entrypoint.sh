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
mkdir -p "$CODEX_HOME_DIR" "$DATA_DIR/images" "$DATA_DIR/prompts"

# 项目自有、codex 可改的工作流目录：缺失时从镜像内 /app/workflows 复制一份（已存在则绝不覆盖）
WORKFLOWS_SRC="${WORKFLOWS_SRC:-/app/workflows}"
if [ ! -d "$DATA_DIR/workflows" ] && [ -d "$WORKFLOWS_SRC" ]; then
  cp -R "$WORKFLOWS_SRC" "$DATA_DIR/workflows.tmp.$$" && mv "$DATA_DIR/workflows.tmp.$$" "$DATA_DIR/workflows" \
    && echo "entrypoint: seeded $DATA_DIR/workflows from $WORKFLOWS_SRC" >&2
fi

# TOML 字符串值只允许安全字符，否则回退默认值
toml_value() {
  case "$1" in
    *[!A-Za-z0-9._-]*|"") echo "entrypoint: WARNING invalid value '$1' for $3, using '$2'" >&2; printf '%s' "$2" ;;
    *) printf '%s' "$1" ;;
  esac
}
# 枚举值：先过 toml_value 的字符检查，再限定在允许列表内，否则回退默认值
toml_enum() {
  _v="$(toml_value "$1" "$2" "$3")"; _def="$2"; _name="$3"; shift 3
  for _a in "$@"; do
    if [ "$_v" = "$_a" ]; then printf '%s' "$_v"; return 0; fi
  done
  echo "entrypoint: WARNING invalid value '$_v' for $_name (allowed: $*), using '$_def'" >&2
  printf '%s' "$_def"
}
# 绝对路径：只允许安全字符
toml_path() {
  case "$1" in
    /*) case "$1" in *[!A-Za-z0-9._/-]*) ;; *) printf '%s' "$1"; return 0 ;; esac ;;
  esac
  echo "entrypoint: WARNING invalid path '$1' for $3, using '$2'" >&2
  printf '%s' "$2"
}
MODEL="$(toml_value "${CODEX_MODEL:-gpt-6.1-sol}" gpt-6.1-sol CODEX_MODEL)"
EFFORT="$(toml_value "${CODEX_REASONING_EFFORT:-high}" high CODEX_REASONING_EFFORT)"
WEB_SEARCH="$(toml_enum "${CODEX_WEB_SEARCH:-live}" live CODEX_WEB_SEARCH live cached disabled)"
WEB_SEARCH_CONTEXT="$(toml_enum "${CODEX_WEB_SEARCH_CONTEXT:-low}" low CODEX_WEB_SEARCH_CONTEXT low medium high)"
BROWSER="$(toml_enum "${CODEX_BROWSER:-playwright}" playwright CODEX_BROWSER playwright none)"
MCP_DATA_DIR="$(toml_path "$DATA_DIR" /data DATA_DIR)"
case "${QQ_CONTEXT_MAX_CHARS:-}" in
  ""|*[!0-9]*) CONTEXT_MAX_CHARS=2500 ;;
  *) CONTEXT_MAX_CHARS="$QQ_CONTEXT_MAX_CHARS" ;;
esac
SANDBOX_NETWORK="$(toml_enum "${CODEX_SANDBOX_NETWORK:-true}" true CODEX_SANDBOX_NETWORK true false)"
# 路径规范化：合并重复的 /，去掉 "/./" 段、末尾的 "/." 与 "/"（根目录保持 "/"）。".." 不在这里处理（调用方直接拒绝）。
norm_path() {
  _p="$(printf '%s' "$1" | sed -e 's#//*#/#g' -e ':a' -e 's#/\./#/#g' -e 'ta' -e 's#/\.$##' -e 's#/$##')"
  printf '%s' "${_p:-/}"
}
DATA_N="$(norm_path "$DATA_DIR")"
CODEX_HOME_N="$(norm_path "$CODEX_HOME_DIR")"
# codex workspace-write 沙箱可写目录：逗号分隔的绝对路径，先规范化再检查；
# /、DATA_DIR 本身及其上级、CODEX_HOME 及其子目录、图片目录、*.sqlite、含 ".." 或非法字符的一律拒绝
WRITABLE_ROOTS=""
WRITABLE_ROOTS_CSV=""
_old_ifs="$IFS"; IFS=','
for _r in ${CODEX_WRITABLE_ROOTS:-$WORKSPACE_DIR,$DATA_DIR/prompts,$DATA_DIR/workflows}; do
  IFS="$_old_ifs"
  _raw="$(printf '%s' "$_r" | tr -d ' ')"
  [ -n "$_raw" ] || { IFS=','; continue; }
  case "$_raw" in
    /*) case "$_raw" in *[!A-Za-z0-9._/-]*|*..*) _bad=1 ;; *) _bad=0 ;; esac ;;
    *) _bad=1 ;;
  esac
  _r="$(norm_path "$_raw")"
  case "$_r" in
    /|"$DATA_N"|"$CODEX_HOME_N"|"$CODEX_HOME_N"/*|"$DATA_N/images"|"$DATA_N/images"/*|*.sqlite|*.sqlite-*) _bad=1 ;;
  esac
  case "$DATA_N/" in "$_r"/*) _bad=1 ;; esac # DATA_DIR 的上级目录
  if [ "$_bad" = 1 ]; then
    echo "entrypoint: WARNING rejected CODEX_WRITABLE_ROOTS entry '$_raw'" >&2
  else
    WRITABLE_ROOTS="${WRITABLE_ROOTS:+$WRITABLE_ROOTS, }\"$_r\""
    WRITABLE_ROOTS_CSV="${WRITABLE_ROOTS_CSV:+$WRITABLE_ROOTS_CSV,}$_r"
  fi
  IFS=','
done
IFS="$_old_ifs"
PLAYWRIGHT_MCP_BIN="${PLAYWRIGHT_MCP_BIN:-/usr/local/bin/playwright-mcp}"
# 浏览器 MCP 进程不受 codex 命令沙箱约束：阻止访问宿主机服务（ComfyUI 8188、NapCat 3000/3001、healthz）
# 与内网/链路本地地址。@playwright/mcp 0.0.83 语义：无协议的项变成 glob "*://<项>/**"，其中 * 匹配 [^/]*，
# 所以 "10.*" 覆盖任意端口；"host" 只匹配无端口 URL，需另加 "host:*"。
# 不是安全边界：不拦截重定向，也不拦截解析到内网 IP 的公网域名（见 DEPLOY.md 残余风险）。
PW_BLOCKED="localhost;localhost:*;*.localhost;*.localhost:*;host.docker.internal;host.docker.internal:*;*.docker.internal;*.docker.internal:*;*.internal;*.internal:*;[::1];[::1]:*;[::];[::]:*;[fc*;[fd*;[fe80*;[::ffff*;0.0.0.0;0.0.0.0:*;127.*;10.*;192.168.*;169.254.*"
for _n in 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31; do PW_BLOCKED="$PW_BLOCKED;172.$_n.*"; done
# Chromium 沙箱：Playwright 默认以 --no-sandbox 启动 Chromium，这里显式 --sandbox 开启。
# 实测（cs-agent:g1，node 用户）：需要 compose 的 seccomp=./docker/seccomp-codex.json（与 codex 的 bwrap 相同前提）；
# 默认 seccomp 下 "Chromium sandboxing failed"，此时设 PLAYWRIGHT_NO_SANDBOX=1 退回无沙箱。
case "${PLAYWRIGHT_NO_SANDBOX:-0}" in
  1|true|yes) PW_SANDBOX_ARG='' ;;
  *) PW_SANDBOX_ARG=', "--sandbox"' ;;
esac
PW_BROWSERS="$(toml_path "${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}" /opt/pw-browsers PLAYWRIGHT_BROWSERS_PATH)"

# config.toml 是受管文件：每次启动都按环境变量重写（先写临时文件再 mv，避免半截文件）
CONFIG="$CODEX_HOME_DIR/config.toml"
cat > "$CONFIG.tmp" <<TOML
# 受管文件：由 entrypoint.sh 在每次容器启动时按环境变量重写（CODEX_MODEL / CODEX_REASONING_EFFORT /
# CODEX_WEB_SEARCH / CODEX_WEB_SEARCH_CONTEXT / CODEX_BROWSER / QQ_CONTEXT_MAX_CHARS）。
# 不要手工修改——改动会在下次启动时被覆盖；请改 .env 后重启容器。不继承宿主机配置。
# model_reasoning_effort 只是默认值：cs-agent 每轮按请求以 -c model_reasoning_effort=... 覆盖。
# qq_context 的访问范围 QQ_ACCESS 不写在这里：cs-agent 每轮以 -c mcp_servers.qq_context.env.QQ_ACCESS=... 注入。
model = "$MODEL"
model_reasoning_effort = "$EFFORT"
web_search = "$WEB_SEARCH"

# codex 命令沙箱（cs-agent 以 -s workspace-write 运行）：命令可联网（CODEX_SANDBOX_NETWORK），
# 只能写下列目录（CODEX_WRITABLE_ROOTS）；/data/codex、*.sqlite、/data/images 不在其中。
[sandbox_workspace_write]
network_access = $SANDBOX_NETWORK
writable_roots = [$WRITABLE_ROOTS]

[tools.web_search]
context_size = "$WEB_SEARCH_CONTEXT"

[mcp_servers.qq_context]
command = "node"
args = ["/app/dist/mcp/qq-context.js"]
startup_timeout_sec = 10
tool_timeout_sec = 15

[mcp_servers.qq_context.env]
DATA_DIR = "$MCP_DATA_DIR"
QQ_CONTEXT_MAX_CHARS = "$CONTEXT_MAX_CHARS"
TOML
if [ "$BROWSER" = "playwright" ]; then
  if [ -x "$PLAYWRIGHT_MCP_BIN" ]; then
    cat >> "$CONFIG.tmp" <<TOML

# 容器内 headless Chromium（无宿主机登录态，--isolated 每次会话用临时 profile）
[mcp_servers.browser]
command = "$(toml_path "$PLAYWRIGHT_MCP_BIN" /usr/local/bin/playwright-mcp PLAYWRIGHT_MCP_BIN)"
args = ["--headless", "--isolated", "--browser", "chromium", "--blocked-origins", "$PW_BLOCKED"$PW_SANDBOX_ARG]
startup_timeout_sec = 30
tool_timeout_sec = 120

[mcp_servers.browser.env]
PLAYWRIGHT_BROWSERS_PATH = "$PW_BROWSERS"
TOML
  else
    echo "entrypoint: WARNING CODEX_BROWSER=playwright but $PLAYWRIGHT_MCP_BIN not found; browser MCP disabled" >&2
  fi
fi
mv -f "$CONFIG.tmp" "$CONFIG"

if [ ! -f "$CODEX_HOME_DIR/auth.json" ]; then
  echo "entrypoint: WARNING $CODEX_HOME_DIR/auth.json missing — run scripts/init-auth.ps1 on the host or 'docker compose run --rm cs-agent codex login --device-auth'" >&2
fi

export CODEX_HOME="$CODEX_HOME_DIR"

if [ "$#" -gt 0 ]; then
  exec "$@"
fi
exec node /app/dist/main.js
