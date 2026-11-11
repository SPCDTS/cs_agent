# 为已安装的原生 stdio MCP 注册交互桌面桥接，不下载安装第三方程序。
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][Guid]$VmId,
    [Parameter(Mandatory = $true)][string]$CredentialPath,
    [Parameter(Mandatory = $true)][string]$GuestWorkdir,
    [Parameter(Mandatory = $true)][string]$DesktopUser,
    [Parameter(Mandatory = $true)][string]$NodePath,
    [Parameter(Mandatory = $true)][string]$Command,
    [string[]]$McpArguments = @('mcp'),
    [string]$ScopeArgument = '--session'
)
$ErrorActionPreference = 'Stop'
$runner = Split-Path $PSScriptRoot -Parent
$bundle = Join-Path $runner 'dist\desktop-mcp-cli.cjs'
if (-not (Test-Path -LiteralPath $bundle)) { throw 'Run npm --prefix runner run build first.' }
if ($ScopeArgument -and $ScopeArgument -notmatch '^--[a-z][a-z0-9-]*$') { throw 'Invalid scope argument.' }
$credential = Import-Clixml -LiteralPath $CredentialPath
$session = New-PSSession -VMId $VmId -Credential $credential
try {
    $root = Invoke-Command -Session $session -ScriptBlock { Join-Path $env:ProgramData 'CsAgentHyperv' }
    # 不覆盖仍在处理请求的桥接；维护者先等待操作结束再停止任务。
    Invoke-Command -Session $session -ScriptBlock {
        $task = Get-ScheduledTask -TaskName 'CsAgentHypervMcpV1' -ErrorAction SilentlyContinue
        if ($task -and $task.State -in 'Running', 'Queued') { throw 'Stop the desktop MCP task before preparing again.' }
    }
    Copy-Item -LiteralPath $bundle -Destination $root -ToSession $session -Force
    foreach ($name in 'desktop-mcp-call.ps1', 'desktop-mcp-launch.ps1', 'Helper.cs', 'Job.cs', 'Desktop.cs') {
        Copy-Item -LiteralPath (Join-Path $runner "native\hyperv\$name") -Destination $root -ToSession $session -Force
    }
    $payload = @{ node = $NodePath; command = $Command; args = @($McpArguments); scopeArgument = $ScopeArgument; user = $DesktopUser; cwd = $GuestWorkdir } | ConvertTo-Json -Depth 5 -Compress
    Invoke-Command -Session $session -ArgumentList $root, $payload -ScriptBlock {
        param([string]$root, [string]$payload)
        $ErrorActionPreference = 'Stop'
        $options = $payload | ConvertFrom-Json
        $setup = [IO.File]::ReadAllText((Join-Path $root 'settings.json'), [Text.Encoding]::UTF8) | ConvertFrom-Json
        if ($setup.version -ne 1 -or $setup.bridgeSid -ne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value -or
            $setup.desktopUser -ine $options.user -or $setup.workdir.TrimEnd('\') -ine $options.cwd.TrimEnd('\')) { throw 'Prepare the matching Hyper-V guest helper first.' }
        $compiler = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
        $context = Join-Path $root 'DesktopContext.exe'
        $sources = @('Helper.cs', 'Job.cs', 'Desktop.cs') | ForEach-Object { Join-Path $root $_ }
        $output = & $compiler /nologo /target:winexe /optimize+ /platform:anycpu "/out:$context" /r:System.Web.Extensions.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll @sources 2>&1
        if ($LASTEXITCODE -ne 0) { throw ('The context helper failed to compile. ' + ($output -join ' ')) }
        foreach ($file in $options.node, $options.command) {
            if ($file -notmatch '^[A-Za-z]:[\\/]' -or -not [IO.File]::Exists($file)) { throw 'Guest executable not found.' }
        }
        $sid = [Security.Principal.NTAccount]::new($options.user).Translate([Security.Principal.SecurityIdentifier])
        $secret = New-Object byte[] 32
        $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
        try { $rng.GetBytes($secret) } finally { $rng.Dispose() }
        $config = @{ pipeName = 'cs-agent-desktop-' + [Guid]::NewGuid().ToString('N'); token = ([BitConverter]::ToString($secret)).Replace('-', '').ToLowerInvariant(); command = $options.command; args = @($options.args); cwd = $options.cwd; desktopSid = $sid.Value }
        if ($options.scopeArgument) { $config.scopeArgument = $options.scopeArgument }
        $utf8 = [Text.UTF8Encoding]::new($false)
        [IO.File]::WriteAllText((Join-Path $root 'desktop-mcp-node.txt'), $options.node, $utf8)
        $configFile = Join-Path $root 'desktop-mcp.json'
        [IO.File]::WriteAllText($configFile, ($config | ConvertTo-Json -Depth 5 -Compress), $utf8)
        $acl = [Security.AccessControl.FileSecurity]::new()
        $acl.SetAccessRuleProtection($true, $false)
        foreach ($admin in 'S-1-5-18', 'S-1-5-32-544') { $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($admin), 'FullControl', 'Allow')) }
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, 'Read', 'Allow'))
        Set-Acl -LiteralPath $configFile -AclObject $acl
        $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
        $action = New-ScheduledTaskAction -Execute $powershell -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + (Join-Path $root 'desktop-mcp-launch.ps1') + '"')
        $principal = New-ScheduledTaskPrincipal -UserId $options.user -LogonType Interactive -RunLevel Limited
        $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval ([TimeSpan]::FromMinutes(1)) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
        $trigger = New-ScheduledTaskTrigger -AtLogOn -User $options.user
        Register-ScheduledTask -TaskName 'CsAgentHypervMcpV1' -Action $action -Principal $principal -Settings $settings -Trigger $trigger -Force | Out-Null
        Start-ScheduledTask -TaskName 'CsAgentHypervMcpV1'
        'Interactive desktop MCP task installed and started.'
    }
} finally { Remove-PSSession -Session $session }
