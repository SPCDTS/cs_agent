[CmdletBinding()]
param(
    [string]$Root = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false, $true)
$Root = [System.IO.Path]::GetFullPath($Root)

# 只读所需的两个键；不执行 .env 内容，不展开变量，不打印凭据。
function Read-NapCatEnv([string]$File) {
    if (-not [System.IO.File]::Exists($File)) { throw '.env not found' }
    $values = @{}
    foreach ($line in [System.IO.File]::ReadAllLines($File, $utf8)) {
        if ($line -notmatch '^\s*(?:export\s+)?(NAPCAT_TOKEN|QQ_BOT_ACCOUNT)\s*=\s*(.*)$') { continue }
        $key = $Matches[1]
        $value = $Matches[2].Trim()
        if ($value.StartsWith("'")) {
            if ($value -notmatch "^'([^']*)'\s*(?:#.*)?$") { throw "Invalid quoted value for $key" }
            $value = $Matches[1]
        } elseif ($value.StartsWith('"')) {
            if ($value -notmatch '^"((?:\\.|[^"\\])*)"\s*(?:#.*)?$') { throw "Invalid quoted value for $key" }
            $value = $Matches[1].Replace('\"', '"').Replace('\\', '\')
        } else {
            $value = ($value -replace '(^|\s+)#.*$', '').Trim()
        }
        $values[$key] = $value
    }
    return $values
}

function New-OneBotConfig([string]$Token) {
    return [ordered]@{
        network = [ordered]@{
            httpServers = @([ordered]@{
                enable = $true; name = 'agent-http'; host = '0.0.0.0'; port = 3000
                enableCors = $false; enableWebsocket = $false
                messagePostFormat = 'array'; token = $Token; debug = $false
            })
            httpSseServers = @()
            httpClients = @()
            websocketServers = @([ordered]@{
                enable = $true; name = 'agent-ws'; host = '0.0.0.0'; port = 3001
                reportSelfMessage = $false; enableForcePushEvent = $true
                messagePostFormat = 'array'; token = $Token; debug = $false; heartInterval = 30000
            })
            websocketClients = @()
            plugins = @()
        }
        musicSignUrl = ''
        enableLocalFile2Url = $false
        parseMultMsg = $false
        imageDownloadProxy = ''
        timeout = [ordered]@{
            baseTimeout = 10000; uploadSpeedKBps = 256; downloadSpeedKBps = 256; maxTimeout = 1800000
        }
    }
}

# JSON 已由 ConvertFrom-Json 校验；这里只定位受管字段的字符串范围。
# 不重序列化整份配置，保留未知字段、数字精度、时间字符串、排版和换行。
function Set-TokenText([string]$Text, [string[]]$Paths, [string]$Token) {
    $parts = [regex]::Matches($Text, '"(?:\\.|[^"\\])*"|[{}\[\]:,]|[^\s{}\[\]:,]+')
    $stack = New-Object System.Collections.ArrayList
    $edits = New-Object System.Collections.ArrayList
    for ($i = 0; $i -lt $parts.Count; $i++) {
        $part = $parts[$i]
        $value = $part.Value
        $parent = if ($stack.Count) { $stack[$stack.Count - 1] } else { $null }
        if ($value -eq '}' -or $value -eq ']') { $stack.RemoveAt($stack.Count - 1); continue }
        if ($value -eq ',') {
            if ($parent.Kind -eq '[') { $parent.Index++ }
            continue
        }
        if ($value -eq ':') { continue }
        if ($parent -and $parent.Kind -eq '{' -and $i + 1 -lt $parts.Count -and $parts[$i + 1].Value -eq ':') {
            $key = ConvertFrom-Json -InputObject $value
            $parent.Key = $key.Replace('~', '~0').Replace('/', '~1')
            continue
        }
        $pointer = if (-not $parent) { '' } elseif ($parent.Kind -eq '[') {
            $parent.Path + '/' + $parent.Index
        } else { $parent.Path + '/' + $parent.Key }
        if ($value -eq '{' -or $value -eq '[') {
            [void]$stack.Add([pscustomobject]@{ Kind = $value; Path = $pointer; Key = ''; Index = 0 })
        } elseif ($Paths -ccontains $pointer) {
            [void]$edits.Add($part)
        }
    }
    if ($edits.Count -ne $Paths.Count) { throw 'Cannot locate managed token fields' }
    $replacement = ConvertTo-Json -InputObject $Token -Compress
    for ($i = $edits.Count - 1; $i -ge 0; $i--) {
        $Text = $Text.Remove($edits[$i].Index, $edits[$i].Length).Insert($edits[$i].Index, $replacement)
    }
    return $Text
}

try {
    $settings = Read-NapCatEnv (Join-Path $Root '.env')
    $token = $settings['NAPCAT_TOKEN']
    if ([string]::IsNullOrWhiteSpace($token)) { throw 'NAPCAT_TOKEN is required in .env' }
    $account = $settings['QQ_BOT_ACCOUNT']
    if ($account -and $account -notmatch '^[0-9]+$') { throw 'QQ_BOT_ACCOUNT must contain only digits' }

    $configDir = Join-Path $Root 'napcat/config'
    $names = @('onebot11.json')
    if ($account) { $names += "onebot11_$account.json" }

    # 先校验所有已有文件，再创建目录或写入，避免第二份配置损坏时只更新第一份。
    $plans = foreach ($name in $names) {
        $file = Join-Path $configDir $name
        if (-not [System.IO.File]::Exists($file)) {
            $json = (New-OneBotConfig $token | ConvertTo-Json -Depth 100) + [Environment]::NewLine
            [pscustomobject]@{ File = $file; Bytes = $utf8.GetBytes($json); Existing = $false }
            continue
        }

        # 读取时检测 BOM；更新时保留原编码、BOM 和换行风格，新文件统一 UTF-8 无 BOM。
        $original = [System.IO.File]::ReadAllBytes($file)
        $reader = New-Object System.IO.StreamReader($file, $utf8, $true)
        try {
            $text = $reader.ReadToEnd()
            $encoding = $reader.CurrentEncoding
        } finally { $reader.Dispose() }
        try { $config = ConvertFrom-Json -InputObject $text } catch { throw "Invalid JSON: $name" }
        $http = @($config.network.httpServers | Where-Object { $_.name -ceq 'agent-http' })
        $ws = @($config.network.websocketServers | Where-Object { $_.name -ceq 'agent-ws' })
        if ($http.Count -ne 1 -or $ws.Count -ne 1 -or
            -not $http[0].PSObject.Properties['token'] -or -not $ws[0].PSObject.Properties['token']) {
            throw "Expected agent-http and agent-ws with token fields: $name"
        }
        if ($http[0].token -ceq $token -and $ws[0].token -ceq $token) {
            [pscustomobject]@{ File = $file; Bytes = $null; Existing = $true }
            continue
        }

        $paths = @()
        foreach ($kind in @('httpServers', 'websocketServers')) {
            $servers = @($config.network.$kind)
            for ($i = 0; $i -lt $servers.Count; $i++) {
                if ($servers[$i] -eq $http[0] -or $servers[$i] -eq $ws[0]) {
                    $paths += "/network/$kind/$i/token"
                }
            }
        }
        $json = Set-TokenText $text $paths $token
        $preamble = $encoding.GetPreamble()
        $hasBom = $preamble.Length -gt 0 -and $original.Length -ge $preamble.Length
        for ($i = 0; $hasBom -and $i -lt $preamble.Length; $i++) {
            $hasBom = $original[$i] -eq $preamble[$i]
        }
        $bytes = $encoding.GetBytes($json)
        if ($hasBom) { $bytes = [byte[]]($preamble + $bytes) }
        [pscustomobject]@{ File = $file; Bytes = $bytes; Existing = $true }
    }

    [void][System.IO.Directory]::CreateDirectory($configDir)
    foreach ($plan in $plans) {
        $name = [System.IO.Path]::GetFileName($plan.File)
        if ($null -eq $plan.Bytes) { Write-Output "unchanged: $name"; continue }
        if ($plan.Existing) {
            $backup = $plan.File + '.bak-' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss-fffffff')
            [System.IO.File]::Copy($plan.File, $backup, $false)
            Write-Output ('backup: ' + [System.IO.Path]::GetFileName($backup))
        }
        [System.IO.File]::WriteAllBytes($plan.File, $plan.Bytes)
        Write-Output "written: $name"
    }
} catch {
    # 不打印 PowerShell 调用栈及 .env/JSON 原文，避免错误路径带出凭据。
    [Console]::Error.WriteLine('napcat-config: ' + $_.Exception.Message)
    exit 1
}
