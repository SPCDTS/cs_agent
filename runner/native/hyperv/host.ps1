
# Windows PowerShell 5.1。标准输入只接收 Base64 编码的 JSON。
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

try {
    $envelope = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd())) | ConvertFrom-Json
    $vmId = [Guid]::ParseExact([string]$envelope.vmId, 'D')
    $credential = Import-Clixml -LiteralPath $envelope.credentialPath
    if ($credential -isnot [pscredential]) { throw 'credential' }

    $guest = @{ workdir = $envelope.guestWorkdir; request = $envelope.request }
    $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($guest | ConvertTo-Json -Depth 80 -Compress)))
    $result = Invoke-Command -VMId $vmId -Credential $credential -ArgumentList $encoded -ScriptBlock {
        param([string]$data)
        $ErrorActionPreference = 'Stop'
        $root = Join-Path $env:ProgramData 'CsAgentHyperv'
        $source = [IO.File]::ReadAllText((Join-Path $root 'bridge.ps1'), [Text.Encoding]::UTF8)
        & ([ScriptBlock]::Create($source)) $data $root
    }
    if ($result -isnot [string]) { throw 'receipt' }
    [Console]::Out.Write($result)
} catch {
    # 避免向调用方泄露凭据、标准错误和 PowerShell 调用栈。
    exit 1
}
