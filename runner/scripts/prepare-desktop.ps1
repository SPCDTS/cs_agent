# 从宿主安装独立的来宾桌面 HTTP MCP；仅安装阶段使用 PowerShell Direct。
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][Guid]$VmId,
    [Parameter(Mandatory = $true)][string]$CredentialPath,
    [Parameter(Mandatory = $true)][string]$GuestWorkdir,
    [Parameter(Mandatory = $true)][string]$DesktopUser,
    [Parameter(Mandatory = $true)][string]$NodePath,
    [Parameter(Mandatory = $true)][string]$Command,
    [Parameter(Mandatory = $true)][string]$TokenPath,
    [ValidateRange(1, 65535)][int]$Port = 7792,
    [string[]]$McpArguments = @('mcp'),
    [string]$ScopeArgument = '--session'
)
$ErrorActionPreference = 'Stop'
$runner = Split-Path $PSScriptRoot -Parent
$bundle = Join-Path $runner 'dist\desktop-cli.cjs'
if (-not [IO.File]::Exists($bundle)) { throw 'Run npm --prefix runner run build first.' }
$token = [IO.File]::ReadAllText($TokenPath, [Text.Encoding]::UTF8).Trim()
if ($token -cnotmatch '^[a-f0-9]{64}$') { throw 'TokenPath must contain a random 32-byte hex token.' }
if ($ScopeArgument -and $ScopeArgument -notmatch '^--[a-z][a-z0-9-]*$') { throw 'Invalid scope argument.' }
$credential = Import-Clixml -LiteralPath $CredentialPath
$session = New-PSSession -VMId $VmId -Credential $credential
try {
    $root = Invoke-Command -Session $session -ArgumentList $DesktopUser -ScriptBlock {
        param([string]$user)
        $ErrorActionPreference = 'Stop'
        $task = Get-ScheduledTask -TaskName 'CsAgentDesktopMcp' -ErrorAction SilentlyContinue
        if ($task -and $task.State -in 'Running', 'Queued') { throw 'Stop CsAgentDesktopMcp before updating.' }
        $root = Join-Path $env:ProgramData 'CsAgentDesktop'
        [void][IO.Directory]::CreateDirectory($root)
        if (([IO.File]::GetAttributes($root) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Install directory must not be a reparse point.' }
        $sid = [Security.Principal.NTAccount]::new($user).Translate([Security.Principal.SecurityIdentifier])
        $acl = [Security.AccessControl.DirectorySecurity]::new()
        $acl.SetAccessRuleProtection($true, $false)
        foreach ($admin in 'S-1-5-18', 'S-1-5-32-544') {
            $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($admin), 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
        }
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, 'ReadAndExecute', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
        Set-Acl -LiteralPath $root -AclObject $acl
        $root
    }
    Copy-Item -LiteralPath $bundle -Destination $root -ToSession $session -Force
    foreach ($name in 'Context.cs', 'launch.ps1') {
        Copy-Item -LiteralPath (Join-Path $runner "native\desktop\$name") -Destination $root -ToSession $session -Force
    }
    $options = @{ node = $NodePath; command = $Command; args = @($McpArguments); scopeArgument = $ScopeArgument; user = $DesktopUser; cwd = $GuestWorkdir; token = $token; port = $Port }
    Invoke-Command -Session $session -ArgumentList $root, $options -ScriptBlock {
        param([string]$root, $options)
        $ErrorActionPreference = 'Stop'
        foreach ($file in $options.node, $options.command) {
            if ($file -notmatch '^[A-Za-z]:[\\/]' -or -not [IO.File]::Exists($file)) { throw 'Guest executable not found.' }
        }
        if ($options.cwd -notmatch '^[A-Za-z]:[\\/]' -or -not [IO.Directory]::Exists($options.cwd)) { throw 'Guest work directory not found.' }
        $compiler = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
        $output = & $compiler /nologo /target:winexe /optimize+ /platform:anycpu "/out:$(Join-Path $root 'DesktopContext.exe')" /r:System.Web.Extensions.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll (Join-Path $root 'Context.cs') 2>&1
        if ($LASTEXITCODE -ne 0) { throw ('Desktop context helper failed to compile. ' + ($output -join ' ')) }
        $sid = [Security.Principal.NTAccount]::new($options.user).Translate([Security.Principal.SecurityIdentifier])
        $config = @{ host = '127.0.0.1'; port = $options.port; token = $options.token; command = $options.command; args = @($options.args); cwd = $options.cwd; desktopSid = $sid.Value }
        if ($options.scopeArgument) { $config.scopeArgument = $options.scopeArgument }
        $utf8 = [Text.UTF8Encoding]::new($false)
        [IO.File]::WriteAllText((Join-Path $root 'config.json'), ($config | ConvertTo-Json -Depth 5 -Compress), $utf8)
        [IO.File]::WriteAllText((Join-Path $root 'node.txt'), $options.node, $utf8)
        $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
        $action = New-ScheduledTaskAction -Execute $powershell -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + (Join-Path $root 'launch.ps1') + '"')
        $principal = New-ScheduledTaskPrincipal -UserId $options.user -LogonType Interactive -RunLevel Limited
        $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval ([TimeSpan]::FromMinutes(1)) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
        $trigger = New-ScheduledTaskTrigger -AtLogOn -User $options.user
        Register-ScheduledTask -TaskName 'CsAgentDesktopMcp' -Action $action -Principal $principal -Settings $settings -Trigger $trigger -Force | Out-Null
        Start-ScheduledTask -TaskName 'CsAgentDesktopMcp'
        'Standalone desktop MCP installed and started.'
    }
} finally { Remove-PSSession -Session $session }
