param([string]$Temp,[string]$Bootstrap,[string]$Node)
$ErrorActionPreference = 'Stop'
$env:LOCALAPPDATA = $Temp
Set-Location $Temp
# node.exe 充当本地测试客户端，join 文件检查真正传给原生进程的凭据路径。
@'
const fs = require("node:fs");
const assert = require("node:assert/strict");
const args = process.argv.slice(2);
const arg = name => args[args.indexOf(name) + 1];
assert.equal(arg("--machine-id"), "paired-1");
assert.equal(arg("--listen"), "127.0.0.1:0");
assert.equal(fs.readFileSync(arg("--relay-token-file"), "utf8"), "a".repeat(64));
assert.equal(fs.readFileSync(arg("--token-file"), "utf8"), "b".repeat(64));
fs.appendFileSync("joined", "ok\n");
'@ | Set-Content -Encoding ascii -LiteralPath 'join'
function Invoke-WebRequest($Uri,$OutFile,$Method,$Headers,$MaximumRedirection,[switch]$UseBasicParsing) {
  if ($OutFile) { [IO.File]::Copy($Node,$OutFile); return }
  if ("$Uri" -ne 'https://agent.example.test/cua/join/claim' -or $Headers.Authorization -ne 'Bearer fixture' -or $Headers['X-Cua-Client'] -cnotmatch '^[a-f0-9]{64}$') { throw 'Wrong enrollment request.' }
  Add-Content -LiteralPath (Join-Path $Temp 'claims') -Value 'claimed'
  return [pscustomobject]@{Content=("wss://relay.example.test","paired-1",('a'*64),('b'*64) -join "`n")}
}
function Get-FileHash($LiteralPath) {
  if ((Microsoft.PowerShell.Utility\Get-FileHash -LiteralPath $LiteralPath).Hash -ne (Microsoft.PowerShell.Utility\Get-FileHash -LiteralPath $Node).Hash) { throw 'Wrong fixture binary.' }
  return @{Hash='7ef20a5c8cf9efc2adf1ad15344189094a793ddfed3c0b9a1e17a4733f9af5c7'}
}
& $Bootstrap 'https://agent.example.test' 'fixture'
if ($LASTEXITCODE) { throw 'Join failed.' }
$local = Get-ChildItem -LiteralPath $Temp -Filter connect.ps1 -Recurse | Select-Object -First 1
& $local.FullName 'https://agent.example.test'
if ($LASTEXITCODE -or @(Get-Content -LiteralPath 'claims').Count -ne 1 -or (Get-Content -LiteralPath 'joined').Count -ne 2) { throw 'Reconnect failed.' }
if (!(Get-Acl -LiteralPath $local.DirectoryName).AreAccessRulesProtected) { throw 'Credential directory still inherits permissions.' }
