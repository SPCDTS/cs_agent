
param([Parameter(Mandatory = $true)][string]$Encoded, [Parameter(Mandatory = $true)][string]$InstallRoot)

$ErrorActionPreference = 'Stop'
$utf8 = [Text.UTF8Encoding]::new($false)
$envelope = $utf8.GetString([Convert]::FromBase64String($Encoded)) | ConvertFrom-Json
$setup = [IO.File]::ReadAllText((Join-Path $InstallRoot 'settings.json'), $utf8) | ConvertFrom-Json
$request = $envelope.request
if ($setup.version -ne 1 -or
    ($setup.bridgeSid -ne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value) -or
    ([IO.Path]::GetFullPath($envelope.workdir).TrimEnd('\') -ine $setup.workdir.TrimEnd('\')) -or
    ([string]$envelope.desktopUser -ine [string]$setup.desktopUser)) { throw 'guest_configuration_mismatch' }

function Write-Receipt($value) {
    $value | ConvertTo-Json -Depth 8 -Compress
}

function Test-Claim([string]$Path) {
    try {
        $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    } catch [IO.IOException] {
        if ([IO.File]::Exists($Path)) { return $false }
        throw
    }
    try { $stream.Flush($true) } finally { $stream.Dispose() }
    return $true
}

function Write-Atomic([string]$Path, [string]$Value, [switch]$IfAbsent) {
    $temporary = $Path + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
    try {
        [IO.File]::WriteAllText($temporary, $Value, $utf8)
        try {
            [IO.File]::Move($temporary, $Path)
        } catch [IO.IOException] {
            if (-not $IfAbsent -or -not [IO.File]::Exists($Path)) { throw }
        }
    } finally { [IO.File]::Delete($temporary) }
}

function Read-Terminal {
    if (-not [IO.File]::Exists($terminal)) { return }
    if ([IO.FileInfo]::new($terminal).Length -gt 10485760) { throw 'receipt_limit' }
    [IO.File]::ReadAllText($terminal, $utf8)
}

function Inspect-Job {
    $result = Read-Terminal
    if ($result) { return $result }
    if ([IO.File]::Exists($claim) -and [IO.File]::ReadAllText($claim, $utf8) -ceq 'stopped') {
        return Write-Receipt @{ state = 'cancelled' }
    }
    $livePath = Join-Path $directory 'live.json'
    if ([IO.File]::Exists($livePath)) {
        $live = [IO.File]::ReadAllText($livePath, $utf8) | ConvertFrom-Json
        try {
            $process = [Diagnostics.Process]::GetProcessById([int]$live.pid)
            try {
                if ([string]$process.StartTime.ToUniversalTime().Ticks -ceq [string]$live.startedTicks) {
                    return Write-Receipt @{ state = 'running' }
                }
            } finally { $process.Dispose() }
        } catch [ArgumentException] {}
        catch [InvalidOperationException] {}
        $result = Read-Terminal
        if ($result) { return $result }
    } else {
        $acceptedPath = Join-Path $directory 'scheduled'
        if ([IO.File]::Exists($acceptedPath) -and
            [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -lt [long][IO.File]::ReadAllText($acceptedPath, $utf8)) {
            return Write-Receipt @{ state = 'running' }
        }
    }
    Write-Receipt @{ state = 'unknown'; error = 'guest_receipt_missing' }
}

function Start-Helper([string]$Task, [string]$Id) {
    $service = New-Object -ComObject 'Schedule.Service'
    $service.Connect()
    $definition = $service.GetFolder('\').GetTask($Task)
    $running = $definition.Run([string]$Id)
    if (-not $running) { throw 'guest_task_launch_unknown' }
}

if ($request.action -eq 'probe') {
    if (-not [IO.File]::Exists((Join-Path $InstallRoot 'Helper.exe'))) { throw 'guest_helper_missing' }
    $service = New-Object -ComObject 'Schedule.Service'
    $service.Connect()
    $folder = $service.GetFolder('\')
    if (-not $folder.GetTask('CsAgentHypervShellV1').Enabled) { throw 'guest_task_disabled' }
    $desktopConfigured = $false
    if ($setup.desktopSid) { $desktopConfigured = [bool]$folder.GetTask('CsAgentHypervDesktopV1').Enabled }
    return Write-Receipt @{ desktopConfigured = $desktopConfigured }
}

$id = [string]$request.id
if ($id -cnotmatch '^[a-fA-F0-9-]{32,64}$') { throw 'invalid_internal_id' }
$root = if ($request.action -eq 'screen') { 'screens' } else { 'jobs' }
$directory = Join-Path (Join-Path $InstallRoot $root) $id
$terminal = Join-Path $directory 'terminal.json'
$claim = Join-Path $directory 'claim'
switch ($request.action) {
    'inspect' { return Inspect-Job }
    'stop' {
        [void][IO.Directory]::CreateDirectory($directory)
        [void](Test-Claim (Join-Path $directory 'cancel'))
        # 取消与助手首次执行共用同一个独占文件。
        if (-not [IO.File]::Exists($claim) -and -not [IO.File]::Exists($terminal)) {
            Write-Atomic $claim 'stopped' -IfAbsent
        }
        return Inspect-Job
    }
    { $_ -in 'dispatch', 'screen' } {
        [void][IO.Directory]::CreateDirectory($directory)
        if (-not (Test-Claim (Join-Path $directory 'dispatch'))) { return Inspect-Job }

        $cancel = Join-Path $directory 'cancel'
        if ([IO.File]::Exists($cancel) -or [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -ge [long]$request.deadline) {
            Write-Atomic $terminal (Write-Receipt @{ state = 'cancelled' })
            return Inspect-Job
        }

        $desktop = $request.action -eq 'screen' -or $request.command.kind -eq 'desktop'
        if ($desktop -and -not $setup.desktopSid) {
            Write-Atomic $terminal (Write-Receipt @{ state = 'failed'; error = 'desktop_unavailable' })
            return Inspect-Job
        }

        $requestPath = Join-Path $directory 'request.json'
        if ($desktop) {
            $payload = @{
                kind = if ($request.action -eq 'screen') { 'screen' } else { 'desktop' }
                desktopSid = [string]$setup.desktopSid
                deadline = [long]$request.deadline
                frame = $request.frame
                action = $request.command.action
            }
            $task = 'CsAgentHypervDesktopV1'
        } else {
            if ($request.command.kind -ne 'powershell') { throw 'invalid_command_kind' }
            $cwd = $setup.workdir
            if ($request.command.cwd) {
                $given = [string]$request.command.cwd
                try {
                    $path = if ($given -match '^(?:[A-Za-z]:[\\/]|[\\/]{2})') { $given } else { Join-Path $setup.workdir $given }
                    $cwd = [IO.Path]::GetFullPath($path)
                } catch {
                    Write-Atomic $terminal (Write-Receipt @{ state = 'failed'; error = 'invalid_guest_cwd' })
                    return Inspect-Job
                }
            }
            $payload = @{ kind = 'powershell'; deadline = [long]$request.deadline; cwd = $cwd }
            # Windows PowerShell 5.1 读取含非 ASCII 字符的脚本时需要 BOM。
            [IO.File]::WriteAllText((Join-Path $directory 'script.ps1'), [string]$request.command.script, [Text.UTF8Encoding]::new($true))
            $task = 'CsAgentHypervShellV1'
        }
        Write-Atomic $requestPath (Write-Receipt $payload)

        if ($desktop) {
            $acl = Get-Acl -LiteralPath $directory
            $desktopSid = [Security.Principal.SecurityIdentifier]::new([string]$setup.desktopSid)
            $rule = [Security.AccessControl.FileSystemAccessRule]::new($desktopSid, 'Modify', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
            $acl.AddAccessRule($rule)
            Set-Acl -LiteralPath $directory -AclObject $acl
        }

        try {
            $taskArgument = if ($request.action -eq 'screen') { 's-' + $id } else { $id }
            Start-Helper $task $taskArgument
        } catch {
            if ($request.action -eq 'screen') { return Write-Receipt @{ state = 'failed'; error = 'desktop_unavailable' } }
            for ($failure = $_.Exception; $failure; $failure = $failure.InnerException) {
                if ($desktop -and $failure.HResult -eq [int]0x80041320) {
                    Write-Atomic $terminal (Write-Receipt @{ state = 'failed'; error = 'desktop_unavailable' })
                    return Inspect-Job
                }
            }
            throw
        }

        if ($request.action -eq 'dispatch') {
            Write-Atomic (Join-Path $directory 'scheduled') ([string]$request.deadline)
            return Inspect-Job
        }

        do {
            $result = Read-Terminal
            if ($result) {
                foreach ($name in 'terminal.json', 'request.json', 'live.json', 'dispatch', 'claim') {
                    [IO.File]::Delete((Join-Path $directory $name))
                }
                [IO.Directory]::Delete($directory)
                return $result
            }
            Start-Sleep -Milliseconds 100
        } while ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -lt [long]$request.deadline)
        return Write-Receipt @{ state = 'failed'; error = 'desktop_unavailable' }
    }
    default { throw 'invalid_bridge_operation' }
}
