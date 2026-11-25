param([Parameter(Mandatory=$true)][string]$Origin,[string]$Ticket)
$ErrorActionPreference = 'Stop'
if ($Origin -cnotmatch '^https://[a-zA-Z0-9.-]+(:[0-9]+)?$') { throw 'Invalid cs-agent origin.' }
$arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
if ($arch -ne 'AMD64') { throw 'This Cua release requires Windows x64.' }
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
function Hex([byte[]]$Bytes) { [BitConverter]::ToString($Bytes).Replace('-','').ToLowerInvariant() }
$sha = [Security.Cryptography.SHA256]::Create()
$prefix = (Hex ($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Origin)))).Substring(0,16)
$base = Join-Path $env:LOCALAPPDATA "cs-agent\cua\$prefix"
[void][IO.Directory]::CreateDirectory($base)
$userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = [Security.AccessControl.DirectorySecurity]::new()
$acl.SetAccessRuleProtection($true,$false)
$acl.SetOwner($userSid)
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($userSid,'FullControl','ContainerInherit, ObjectInherit','None','Allow'))
Set-Acl -LiteralPath $base -AclObject $acl
$work = Join-Path $base ([Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($work)
$bin = Join-Path $base 'cua-spacesd.exe'
$profileDir = Join-Path $base 'device'
try {
  $connect = Join-Path $base 'connect.ps1'
  if ($PSCommandPath -ne $connect) { Copy-Item -LiteralPath $PSCommandPath -Destination $connect -Force }
  $want = '7ef20a5c8cf9efc2adf1ad15344189094a793ddfed3c0b9a1e17a4733f9af5c7'
  if (!(Test-Path -LiteralPath $bin) -or (Get-FileHash -LiteralPath $bin).Hash -ne $want) {
    $file = Join-Path $work 'client.exe'
    Invoke-WebRequest -UseBasicParsing 'https://github.com/trycua/cua/releases/download/cua-spacesd-v0.17.2/cua-spacesd-x86_64-pc-windows-msvc.exe' -OutFile $file
    if ((Get-FileHash -LiteralPath $file).Hash -ne $want) { throw 'Cua SHA-256 mismatch.' }
    Move-Item -LiteralPath $file -Destination $bin -Force
  }
  if (!(Test-Path -LiteralPath $profileDir)) {
    if (!$Ticket) { throw 'Generate a pairing command in the cs-agent console.' }
    $key = Join-Path $base 'client.key'
    if (!(Test-Path -LiteralPath $key)) {
      $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
      $bytes = New-Object byte[] 32
      $rng.GetBytes($bytes)
      $newKey = Join-Path $work 'key'
      [IO.File]::WriteAllText($newKey,(Hex $bytes))
      try { [IO.File]::Move($newKey,$key) } catch [IO.IOException] { if (!(Test-Path -LiteralPath $key)) { throw } }
    }
    $reply = Invoke-WebRequest -UseBasicParsing -Method Post -MaximumRedirection 0 -Uri "$Origin/cua/join/claim" -Headers @{Authorization="Bearer $Ticket";'X-Cua-Client'=[IO.File]::ReadAllText($key)}
    $lines = $reply.Content.TrimEnd().Split([char]10)
    if ($lines.Count -ne 4 -or $lines[0] -cnotmatch '^wss://[a-zA-Z0-9.-]+(:[0-9]+)?$' -or $lines[1] -cnotmatch '^paired-[0-9]+$' -or $lines[2] -cnotmatch '^[a-f0-9]{64}$' -or $lines[3] -cnotmatch '^[a-f0-9]{64}$') { throw 'Invalid enrollment response.' }
    $stage = Join-Path $work 'device'
    [void][IO.Directory]::CreateDirectory($stage)
    $names = @('relay','id','registration.token','device.token')
    for ($i=0; $i -lt 4; $i++) { [IO.File]::WriteAllText((Join-Path $stage $names[$i]),$lines[$i]) }
    try { [IO.Directory]::Move($stage,$profileDir) } catch [IO.IOException] { if (!(Test-Path -LiteralPath $profileDir)) { throw } }
  }
} finally { Remove-Item -LiteralPath $work -Force -Recurse }
Write-Host "Connecting. Keep this window open. To reconnect, run:"
Write-Host ("& '{0}' '{1}'" -f $connect.Replace("'","''"),$Origin)
& $bin join --relay ([IO.File]::ReadAllText((Join-Path $profileDir 'relay'))) --machine-id ([IO.File]::ReadAllText((Join-Path $profileDir 'id'))) --machine-id-file (Join-Path $profileDir 'machine-id') --relay-token-file (Join-Path $profileDir 'registration.token') --token-file (Join-Path $profileDir 'device.token') --listen 127.0.0.1:0 --no-mcp --quic-port 0
exit $LASTEXITCODE
