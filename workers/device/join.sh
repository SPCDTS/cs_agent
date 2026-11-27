#!/bin/bash
# 由管理台提供源站和短期配对凭据。再次启动只读取本机保存的原生凭据。
set -euo pipefail
umask 077
origin=${1:?需要管理台的 HTTPS 地址}
ticket=${2:-}
[[ "$origin" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?$ && "$(uname -s)" == Darwin ]] || exit 2
case "$(uname -m)" in
  arm64) arch=aarch64 ;;
  x86_64) arch=x86_64 ;;
  *) echo '暂不支持此 Mac 架构。' >&2; exit 2 ;;
esac
prefix="$(printf %s "$origin" | shasum -a 256 | cut -c1-16)"
base="$HOME/Library/Application Support/joule/cua/$prefix"
legacy_base="$HOME/Library/Application Support/cs-agent/cua/$prefix"
if [[ ! -d "$base" && -d "$legacy_base" ]]; then
  mkdir -p "$(dirname "$base")"
  mv "$legacy_base" "$base" 2>/dev/null || base="$legacy_base"
fi
mkdir -p "$base"
exec 9>>"$base/join.lock"
/usr/bin/lockf -s -t 0 9 || { echo '这台设备已有连接进程。' >&2; exit 1; }
work=$(mktemp -d "$base/.join.XXXXXXXX")
trap 'rm -rf "$work"' EXIT
cp "$0" "$work/connect.sh"
mv "$work/connect.sh" "$base/connect.sh"
bin="$base/cua-spacesd"
hash=c936e2a1ac0e00d5d336c81fd5f03fb19d6aa3ec53382f8f621a589e4ab1e37b
verify() { [[ -f "$1" && "$(shasum -a 256 < "$1" | cut -d' ' -f1)" == "$hash" ]]; }
if ! verify "$bin"; then
  curl -fsSL --proto '=https' --proto-redir '=https' --retry 2 \
    "https://github.com/trycua/cua/releases/download/cua-spacesd-v0.17.2/cua-spacesd-$arch-apple-darwin" -o "$work/client"
  verify "$work/client" || { echo '客户端 SHA-256 校验失败。' >&2; exit 1; }
  chmod 700 "$work/client"
  mv "$work/client" "$bin"
fi
profile="$base/device"
if [[ ! -d "$profile" ]]; then
  [[ -n "$ticket" ]] || { echo '请在管理台生成接入命令。' >&2; exit 1; }
  if [[ ! -f "$base/client.key" ]]; then
    openssl rand -hex 32 > "$work/key"
    ln "$work/key" "$base/client.key" 2>/dev/null || [[ -s "$base/client.key" ]]
  fi
  # curl 从标准输入读头，设备领取证明不会出现在进程参数或调试日志中。
  printf 'Authorization: Bearer %s\nX-Cua-Client: %s\n' "$ticket" "$(cat "$base/client.key")" | \
    curl -fsS --proto '=https' --max-time 20 -H @- -X POST "$origin/cua/join/claim" -o "$work/reply"
  mkdir "$work/device"
  { IFS= read -r relay; IFS= read -r machine; IFS= read -r registration; IFS= read -r device; } < "$work/reply"
  [[ "$relay" =~ ^wss://[A-Za-z0-9.-]+(:[0-9]+)?$ && "$machine" =~ ^paired-[0-9]+$ && "$registration" =~ ^[a-f0-9]{64}$ && "$device" =~ ^[a-f0-9]{64}$ ]] || exit 1
  printf '%s\n' "$relay" > "$work/device/relay"
  printf '%s\n' "$machine" > "$work/device/id"
  printf '%s\n' "$registration" > "$work/device/registration.token"
  printf '%s\n' "$device" > "$work/device/device.token"
  mv "$work/device" "$profile"
fi
rm -rf "$work"
trap - EXIT
printf '正在连接。设备出现后即可在管理台分配。按 Ctrl+C 断开，再次连接运行：\nbash %q %q\n' "$base/connect.sh" "$origin"
exec "$bin" join --relay "$(cat "$profile/relay")" --machine-id "$(cat "$profile/id")" \
  --machine-id-file "$profile/machine-id" --relay-token-file "$profile/registration.token" \
  --token-file "$profile/device.token" --listen 127.0.0.1:0 --no-mcp --quic-port 0
