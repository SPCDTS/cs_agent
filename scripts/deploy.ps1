# 部署 cs-agent（只在用户明确要求后运行，约定见 CLAUDE.md）：
# 取部署锁，在部署 worktree 按指定提交构建镜像，列出本次上线的全部提交，等 agent 空闲后重建容器，
# 核对健康状态与容器内 COMMIT，结果追加到 .git/deploy.log。
#   scripts/deploy.ps1 -By <会话名>                     部署 main 最新提交
#   scripts/deploy.ps1 -By <会话名> -Commit <提交> -Wait 10
#   scripts/deploy.ps1 -By <会话名> -DryRun             只取锁、检出、列提交、查空闲，不构建不重启
param(
  [Parameter(Mandatory)][string]$By,
  [string]$Commit = "main",
  [int]$Wait = 0,
  [switch]$DryRun
)
$ErrorActionPreference = "Stop"

function Invoke-Git {
  $out = & git @args
  if ($LASTEXITCODE) { throw "git $($args -join ' ') 失败（退出码 $LASTEXITCODE）" }
  $out
}

$common = Invoke-Git -C $PSScriptRoot rev-parse --path-format=absolute --git-common-dir
$main = Split-Path $common -Parent
$deploy = "$main-deploy"
$log = Join-Path $common "deploy.log"
$target = Invoke-Git -C $main rev-parse --verify "$Commit^{commit}"
$short = $target.Substring(0, 7)
function Write-Log($status) { Add-Content $log ("{0}`t{1}`t{2}`t{3}" -f (Get-Date -Format "yyyy-MM-ddTHH:mm:sszzz"), $By, $short, $status) }

# 句柄关闭即删除：进程被杀时锁随之释放，不会留下死锁文件。
try {
  $lock = [System.IO.FileStream]::new((Join-Path $common "deploy.lock"), [System.IO.FileMode]::CreateNew,
    [System.IO.FileAccess]::Write, [System.IO.FileShare]::None, 1, [System.IO.FileOptions]::DeleteOnClose)
} catch {
  $last = if (Test-Path $log) { Get-Content $log -Tail 1 } else { "" }
  throw "另一个部署正在进行。最近一条记录：$last"
}

Write-Log ($DryRun ? "dry-run" : "start")
try {
  if (!(Test-Path $deploy)) { Invoke-Git -C $main worktree add -q --detach $deploy $target | Out-Null }
  if (Invoke-Git -C $deploy status --porcelain --untracked-files=no) { throw "部署 worktree 有改动：$deploy" }
  Invoke-Git -C $deploy checkout -q --detach $target

  $vars = docker inspect cs-agent --format '{{range .Config.Env}}{{println .}}{{end}}' 2>$null
  $running = ($vars | Select-String '^CS_AGENT_COMMIT=([0-9a-f]+)').Matches.Groups[1].Value
  if ($running) { & git -C $main cat-file -e "$running^{commit}" 2>$null }
  if ($running -and !$LASTEXITCODE) {
    $commits = Invoke-Git -C $main log --format="%h %s" "$running..$target"
    "线上 $($running.Substring(0, 7)) -> $short，本次上线 $(@($commits).Count) 个提交（确认都经用户同意）："
    $commits | ForEach-Object { "  " + ($_.Length -gt 100 ? $_.Substring(0, 100) : $_) }
  } else { "线上提交未知，目标 $short" }

  if (!$DryRun) {
    $build = @("build", "-q", "--build-arg", "GIT_COMMIT=$target", "--build-arg", "BUILD_TIME=$((Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'))", "-t", "cs-agent:dev")
    docker @build $deploy
    if ($LASTEXITCODE) {
      # Dockerfile 首行 syntax 指令要联网拉前端镜像；拉不到时去掉首行用内置前端重试。
      "构建失败，去掉 syntax 指令重试"
      Get-Content (Join-Path $deploy Dockerfile) | Select-Object -Skip 1 | docker @build -f - $deploy
      if ($LASTEXITCODE) { throw "镜像构建失败" }
    }
  }

  $token = (Get-Content (Join-Path $main "data/obs-token") -Raw).Trim()
  $deadline = (Get-Date).AddMinutes($Wait)
  while ($true) {
    try {
      $threads = Invoke-RestMethod "http://127.0.0.1:8787/api/agents/topology" -Headers @{ Cookie = "obs_token=$token" } -TimeoutSec 10
    } catch { "面板不可达，视为空闲：$($_.Exception.Message)"; break }
    $busy = @($threads | Where-Object { $_.busy -or @($_.children | Where-Object status -eq "running").Count })
    if (!$busy.Count) { "agent 空闲"; break }
    if ((Get-Date) -gt $deadline) { throw "agent 忙：$(($busy | ForEach-Object thread) -join ', ')；可加 -Wait <分钟> 等待" }
    Start-Sleep 15
  }
  if ($DryRun) { "dry-run 结束，未构建、未重启"; return }

  # compose 在主工作区运行：.env、data/、secrets/ 都在那里。
  Push-Location $main
  try {
    $services = @("cs-agent") + @(docker compose config --services | Where-Object { $_ -eq "gmail-sidecar" })
    docker compose up -d --no-build @services
    if ($LASTEXITCODE) { throw "docker compose up 失败" }
    $containers = docker compose ps -q @services
  } finally { Pop-Location }
  foreach ($id in $containers) {
    for ($i = 0; $i -lt 45; $i++) {
      $health = docker inspect $id --format '{{.State.Health.Status}}'
      if ($health -eq "healthy") { break }
      Start-Sleep 4
    }
    $name = docker inspect $id --format '{{.Name}}'
    if ($health -ne "healthy") { throw "$name 未就绪：$health" }
    "$name healthy"
  }
  $deployed = docker exec cs-agent head -1 /app/source/COMMIT
  if ($deployed -ne "commit=$target") { throw "容器内提交不符：$deployed" }
  Write-Log "ok"
  "已部署 $short"
} catch {
  Write-Log "failed: $($_.Exception.Message)"
  throw
} finally {
  $lock.Dispose()
}
