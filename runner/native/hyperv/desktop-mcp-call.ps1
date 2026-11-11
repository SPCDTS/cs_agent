param([Parameter(Mandatory = $true)][string]$Encoded, [Parameter(Mandatory = $true)][string]$InstallRoot)
$ErrorActionPreference = 'Stop'
$utf8 = [Text.UTF8Encoding]::new($false)
$envelope = $utf8.GetString([Convert]::FromBase64String($Encoded)) | ConvertFrom-Json
$setup = [IO.File]::ReadAllText((Join-Path $InstallRoot 'settings.json'), $utf8) | ConvertFrom-Json
if ($setup.version -ne 1 -or
    $setup.bridgeSid -ne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value -or
    [IO.Path]::GetFullPath($envelope.workdir).TrimEnd('\') -ine $setup.workdir.TrimEnd('\') -or
    [string]$envelope.desktopUser -ine [string]$setup.desktopUser) { throw 'guest_configuration_mismatch' }
$config = [IO.File]::ReadAllText((Join-Path $InstallRoot 'desktop-mcp.json'), $utf8) | ConvertFrom-Json
if ($config.desktopSid -ne $setup.desktopSid -or $config.pipeName -notmatch '^cs-agent-desktop-[a-f0-9]{32}$') { throw 'guest_configuration_mismatch' }
$request = $envelope.request
$message = @{ token = $config.token; scope = $request.scope; deadline = $request.deadline; operation = $request.operation } | ConvertTo-Json -Depth 80 -Compress
$bytes = $utf8.GetBytes($message + "`n")
if ($bytes.Length -gt 524288) { throw 'desktop_mcp_request_limit' }
$pipe = [IO.Pipes.NamedPipeClientStream]::new('.', $config.pipeName, [IO.Pipes.PipeDirection]::InOut, [IO.Pipes.PipeOptions]::Asynchronous)
$reply = [IO.MemoryStream]::new()
try {
    try { $pipe.Connect(3000) } catch { return '{"ok":false,"error":"desktop_mcp_unavailable"}' }
    $pipe.Write($bytes, 0, $bytes.Length)
    $pipe.Flush()
    $buffer = New-Object byte[] 16384
    while ($true) {
        $remaining = [Math]::Min(55000, [long]$request.deadline - [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
        if ($remaining -le 0) { throw 'desktop_mcp_outcome_unknown' }
        $read = $pipe.ReadAsync($buffer, 0, $buffer.Length)
        if (-not $read.Wait([int]$remaining)) { throw 'desktop_mcp_outcome_unknown' }
        $count = $read.Result
        if ($count -eq 0) { throw 'desktop_mcp_outcome_unknown' }
        if ($reply.Length + $count -gt 12582912) { throw 'desktop_mcp_result_limit' }
        $reply.Write($buffer, 0, $count)
        if ($buffer[$count - 1] -eq 10) { return $utf8.GetString($reply.ToArray()).TrimEnd("`n") }
    }
} catch { return '{"ok":false,"error":"desktop_mcp_outcome_unknown"}' }
finally { $pipe.Dispose(); $reply.Dispose() }
