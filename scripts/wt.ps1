# 每个任务一个 worktree；新任务使用 codex/ 分支和独立 Workers 依赖。
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
Invoke-Git -C $main config core.hooksPath scripts/hooks | Out-Null
if ($Action -eq "list") { Invoke-Git -C $main worktree list; return }
if (!$Name) { throw "缺少名称：scripts/wt.ps1 $Action <名称>" }
$path = [System.IO.Path]::GetFullPath("$main-wt-$Name")
$branch = "codex/$Name"
if ($Action -ne "new") {
  $branch = Invoke-Git -C $path symbolic-ref --short HEAD
}
function Assert-Clean($dir, $what) {
  if (Invoke-Git -C $dir status --porcelain --untracked-files=no) { throw "$what 有未提交改动：$dir" }
}
switch ($Action) {
  "new" {
    if (Test-Path -LiteralPath $path) { throw "已存在：$path" }
    Invoke-Git -C $main worktree add -q -b $branch $path main | Out-Null
    "worktree：$path（分支 $branch）。进入后运行 npm run install:workers，依赖只安装在该 worktree。"
  }
  "land" {
    Assert-Clean $path "worktree"
    Invoke-Git -C $path rebase -q main | Out-Null
    if (!$SkipTests) {
      Push-Location $path
      try {
        npm run check
        if ($LASTEXITCODE) { throw "Workers 检查失败" }
      } finally { Pop-Location }
    }
    if ((Invoke-Git -C $main symbolic-ref --short HEAD) -ne "main") { throw "主工作区不在 main 分支" }
    Assert-Clean $main "主工作区"
    Invoke-Git -C $main merge -q --ff-only $branch
    Invoke-Git -C $main log --oneline -1
  }
  "rm" {
    if (!(Test-Path -LiteralPath $path)) { throw "不存在：$path" }
    $entry = Get-Item -LiteralPath $path -Force
    if ($entry.LinkType -or $entry.FullName -ne $path) { throw "worktree 路径不是预期的普通目录：$path" }
    if ((Invoke-Git -C $path rev-parse --show-toplevel).Replace('/', '\') -ne $path.Replace('/', '\')) { throw "worktree 根目录不匹配" }
    if (Invoke-Git -C $path status --porcelain) { throw "worktree 有未提交或未跟踪的文件：$path" }
    # 兼容旧 worktree；只移除目录链接本身，不递归删除其共享目标。
    foreach ($relative in @('node_modules', 'workers/node_modules')) {
      $modules = Get-Item -LiteralPath (Join-Path $path $relative) -Force -ErrorAction SilentlyContinue
      if ($modules -and $modules.LinkType -in @('Junction', 'SymbolicLink')) { [System.IO.Directory]::Delete($modules.FullName, $false) }
    }
    Invoke-Git -C $main worktree remove $path
    & git -C $main branch -d $branch 2>$null
    if ($LASTEXITCODE) { "分支 $branch 尚未合并进 main，已保留" }
  }
}
