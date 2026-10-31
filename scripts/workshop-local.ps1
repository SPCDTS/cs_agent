param(
  [ValidateSet("Run", "Install", "Status", "Stop")][string]$Action = "Status",
  [string]$Root = (Split-Path $PSScriptRoot -Parent)
)
$ErrorActionPreference = "Stop"
$Root = (Resolve-Path -LiteralPath $Root).Path
$TaskName = "cs-agent-workshop"
$Runner = Join-Path $PSScriptRoot "workshop-local.mjs"
$Runtime = Join-Path $Root "data\workshop-bridge"
switch ($Action) {
  "Install" {
    # 使用当前用户的交互会话，让 Workshop 能连接 Steam 和 CS2。
    $User = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    $Shell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
    $Script = Join-Path $Root "scripts\workshop-local.ps1"
    $Arguments = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $Script + '" -Action Run -Root "' + $Root + '"'
    $TaskAction = New-ScheduledTaskAction -Execute $Shell -Argument $Arguments -WorkingDirectory $Root
    $Trigger = New-ScheduledTaskTrigger -AtLogOn -User $User
    $Principal = New-ScheduledTaskPrincipal -UserId $User -LogonType Interactive -RunLevel Limited
    $Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
    Register-ScheduledTask -TaskName $TaskName -Action $TaskAction -Trigger $Trigger -Principal $Principal -Settings $Settings -Description "cs-agent 本机 Workshop MCP 与 Cloudflare Tunnel" -Force | Out-Null
    Start-ScheduledTask -TaskName $TaskName
    Write-Output "已安装并启动 $TaskName；下次登录 Windows 自动启动。"
  }
  "Run" {
    $Node = (Get-Command node.exe -ErrorAction Stop).Source
    $Arguments = '"' + $Runner + '" "' + $Root + '"'
    $Process = Start-Process -FilePath $Node -ArgumentList $Arguments -WorkingDirectory $Root -WindowStyle Hidden -PassThru -Wait -RedirectStandardOutput (Join-Path $Runtime "supervisor.stdout.log") -RedirectStandardError (Join-Path $Runtime "supervisor.stderr.log")
    exit $Process.ExitCode
  }
  "Status" {
    Get-ScheduledTask -TaskName $TaskName | Select-Object TaskName, State
    Get-ScheduledTaskInfo -TaskName $TaskName | Select-Object LastRunTime, LastTaskResult, NextRunTime
    Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 3721 -State Listen -ErrorAction SilentlyContinue | Select-Object LocalAddress, LocalPort, OwningProcess
  }
  "Stop" {
    # Task Scheduler 可能只结束 PowerShell；先通知守护进程回收它自己的子进程。
    $PidFile = Join-Path $Runtime "supervisor.pid"
    if (Test-Path -LiteralPath $PidFile) {
      $SupervisorId = [int][System.IO.File]::ReadAllText($PidFile)
      $Supervisor = Get-CimInstance Win32_Process -Filter "ProcessId = $SupervisorId"
      if ($Supervisor) {
        if ($Supervisor.Name -ne "node.exe" -or $Supervisor.CommandLine.IndexOf($Runner, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
          throw "Supervisor PID does not match this Workshop launcher"
        }
        $StopFile = Join-Path $Root "secrets\workshop\stop.request"
        [System.IO.File]::WriteAllText($StopFile, [string]$SupervisorId, [System.Text.UTF8Encoding]::new($false))
        Wait-Process -Id $SupervisorId -Timeout 15 -ErrorAction Stop
      }
    }
    Stop-ScheduledTask -TaskName $TaskName
    Write-Output "已停止连接进程；制作任务状态请通过 Workshop 核对。"
  }
}
