
param([Parameter(Mandatory = $true)][string]$ScriptPath)

[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
$ErrorActionPreference = 'Stop'
$global:LASTEXITCODE = 0
& $ScriptPath
$success = $?
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
if (-not $success) { exit 1 }
