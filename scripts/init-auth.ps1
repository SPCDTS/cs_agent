# 把宿主机 ~/.codex/auth.json 复制到 ./data/codex/auth.json（容器内 codex 与 agent 共用）。
# 只复制文件，不输出任何 token 内容。
param(
  [string]$Source = (Join-Path $env:USERPROFILE ".codex\auth.json"),
  [switch]$Force
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$destDir = Join-Path $root "data\codex"
$dest = Join-Path $destDir "auth.json"

if (-not (Test-Path $Source)) { throw "找不到 $Source；请先在宿主机执行 codex login" }
$json = Get-Content $Source -Raw | ConvertFrom-Json
if ($json.auth_mode -ne "chatgpt" -or -not $json.tokens.refresh_token) {
  throw "auth.json 不是 auth_mode=chatgpt 或缺少 tokens"
}
New-Item -ItemType Directory -Force $destDir | Out-Null
if ((Test-Path $dest) -and -not $Force) {
  Write-Host "已存在 $dest（使用 -Force 覆盖）"
  exit 0
}
Copy-Item $Source $dest -Force
Write-Host "已复制 auth.json -> $dest"
Write-Host "注意：容器与宿主机各自刷新 refresh_token 后，两边可能互相失效；以容器内这份为准，宿主机失效时重新 codex login。"
