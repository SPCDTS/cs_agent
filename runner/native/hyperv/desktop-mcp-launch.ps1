$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$node = [IO.File]::ReadAllText((Join-Path $root 'desktop-mcp-node.txt'), [Text.Encoding]::UTF8).Trim()
$start = [Diagnostics.ProcessStartInfo]::new()
$start.FileName = $node
$start.Arguments = '"' + (Join-Path $root 'desktop-mcp-cli.cjs') + '" "' + (Join-Path $root 'desktop-mcp.json') + '"'
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$process = [Diagnostics.Process]::Start($start)
try { $process.WaitForExit(); exit $process.ExitCode } finally { $process.Dispose() }
