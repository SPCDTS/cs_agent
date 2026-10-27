# 多 agent 开发的 worktree 管理：每个任务一个 worktree，主工作区只做快进合并（约定见 CLAUDE.md）。
#   scripts/wt.ps1 new <名称>    从 main 建 <主工作区>-wt-<名称>，分支 <名称>，node_modules 链接到主工作区
#   scripts/wt.ps1 land <名称>   rebase 到 main、typecheck + 单测，再在主工作区 merge --ff-only
#   scripts/wt.ps1 rm <名称>     先断开 node_modules 链接再删 worktree；分支已合并则一并删除
#   scripts/wt.ps1 list
param(
  [Parameter(Mandatory, Position = 0)][ValidateSet("new", "land", "rm", "list")][string]$Action,
  [Parameter(Position = 1)][ValidatePattern('^[a-z0-9][a-z0-9-]*$')][string]$Name,
  [switch]$SkipTests
)
$ErrorActionPreference = "Stop"

function Invoke-Git {
  $out = & git @args
  if ($LASTEXITCODE) { throw "git $($args -join ' ') 失败（退出码 $LASTEXITCODE）" }
  $out
}

$main = Split-Path (Invoke-Git -C $PSScriptRoot rev-parse --path-format=absolute --git-common-dir) -Parent
# 主工作区提交钩子随仓库版本化；每次运行都设一次，幂等。
Invoke-Git -C $main config core.hooksPath scripts/hooks | Out-Null
if ($Action -eq "list") { Invoke-Git -C $main worktree list; return }
if (!$Name) { throw "缺少名称：scripts/wt.ps1 $Action <名称>" }
$path = "$main-wt-$Name"

function Assert-Clean($dir, $what) {
  if (Invoke-Git -C $dir status --porcelain --untracked-files=no) { throw "$what 有未提交改动：$dir" }
}

switch ($Action) {
  "new" {
    if (Test-Path $path) { throw "已存在：$path" }
    Invoke-Git -C $main worktree add -q -b $Name $path main | Out-Null
    New-Item -ItemType Junction -Path (Join-Path $path node_modules) -Target (Join-Path $main node_modules) | Out-Null
    "worktree：$path（分支 $Name）。node_modules 链接到主工作区，不要在这里 npm install。"
  }
  "land" {
    Assert-Clean $path "worktree"
    Invoke-Git -C $path rebase -q main | Out-Null
    if (!$SkipTests) {
      Push-Location $path
      try {
        npm run -s typecheck; if ($LASTEXITCODE) { throw "typecheck 失败" }
        npm test --silent; if ($LASTEXITCODE) { throw "单测失败" }
      } finally { Pop-Location }
    }
    if ((Invoke-Git -C $main symbolic-ref --short HEAD) -ne "main") { throw "主工作区不在 main 分支" }
    Assert-Clean $main "主工作区"
    # 测试期间 main 前进时 ff-only 会失败，重跑 land 即可。
    Invoke-Git -C $main merge -q --ff-only $Name
    Invoke-Git -C $main log --oneline -1
  }
  "rm" {
    if (!(Test-Path $path)) { throw "不存在：$path" }
    if (Invoke-Git -C $path status --porcelain) { throw "worktree 有未提交或未跟踪的文件：$path" }
    # git worktree remove 会顺着链接删掉主工作区的 node_modules，必须先断开。
    $modules = Get-Item (Join-Path $path node_modules) -Force -ErrorAction SilentlyContinue
    if ($modules -and $modules.LinkType -eq "Junction") { [System.IO.Directory]::Delete($modules.FullName, $false) }
    Invoke-Git -C $main worktree remove $path
    & git -C $main branch -d $Name 2>$null
    if ($LASTEXITCODE) { "分支 $Name 尚未合并进 main，已保留" }
  }
}
