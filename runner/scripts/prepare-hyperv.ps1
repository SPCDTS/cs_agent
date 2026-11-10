
# 使用运行 MCP 服务的 Windows 用户执行一次。该用户需要访问配置中的 Hyper-V VM。
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][Guid]$VmId,
    [Parameter(Mandatory = $true)][string]$CredentialPath,
    [Parameter(Mandatory = $true)][string]$GuestWorkdir,
    [string]$DesktopUser
)

$ErrorActionPreference = 'Stop'
if ($GuestWorkdir -notmatch '^[A-Za-z]:[\\/]') { throw 'GuestWorkdir must be an absolute local guest path.' }
$credential = Import-Clixml -LiteralPath $CredentialPath
if ($credential -isnot [pscredential]) { throw 'CredentialPath must contain a DPAPI-protected PSCredential.' }

$session = $null
try {
    $session = New-PSSession -VMId $VmId -Credential $credential
    $root = Invoke-Command -Session $session -ArgumentList @($GuestWorkdir, [string]$DesktopUser) -ScriptBlock {
        param([string]$workdir, [string]$desktopUser)
        $ErrorActionPreference = 'Stop'
        if (-not [IO.Directory]::Exists($workdir)) { throw 'The guest working directory must already exist.' }

        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        $principal = [Security.Principal.WindowsPrincipal]::new($identity)
        if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
            throw 'Guest preparation requires a PowerShell Direct administrator.'
        }
        if ($desktopUser) {
            [void][Security.Principal.NTAccount]::new($desktopUser).Translate([Security.Principal.SecurityIdentifier])
        }

        $root = Join-Path $env:ProgramData 'CsAgentHyperv'
        $system = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
        $admins = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
        $inherited = [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
        foreach ($taskName in 'CsAgentHypervShellV1', 'CsAgentHypervDesktopV1') {
            $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
            if ($task -and $task.State -in 'Running', 'Queued') { throw 'Wait for active guest tasks before preparing again.' }
        }
        foreach ($folder in $root, (Join-Path $root 'jobs'), (Join-Path $root 'screens')) {
            [void][IO.Directory]::CreateDirectory($folder)
            if (([IO.File]::GetAttributes($folder) -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw 'Guest helper directories must not be reparse points.'
            }
            $acl = [Security.AccessControl.DirectorySecurity]::new()
            $acl.SetAccessRuleProtection($true, $false)
            foreach ($sid in $system, $admins) {
                $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', $inherited, 'None', 'Allow'))
            }
            $right = if ($folder -eq $root) { 'ReadAndExecute' } else { 'Modify' }
            $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($identity.User, $right, $inherited, 'None', 'Allow'))
            if ($folder -eq $root -and $desktopUser) {
                $desktopSid = [Security.Principal.NTAccount]::new($desktopUser).Translate([Security.Principal.SecurityIdentifier])
                $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($desktopSid, 'ReadAndExecute', $inherited, 'None', 'Allow'))
            }
            Set-Acl -LiteralPath $folder -AclObject $acl
        }
        $root
    }

    $sources = Join-Path (Split-Path $PSScriptRoot -Parent) 'native\hyperv'
    foreach ($name in 'Helper.cs', 'Job.cs', 'Desktop.cs', 'bridge.ps1', 'launch.ps1') {
        Copy-Item -LiteralPath (Join-Path $sources $name) -Destination $root -ToSession $session -Force
    }

    Invoke-Command -Session $session -ArgumentList @($root, $GuestWorkdir, [string]$DesktopUser) -ScriptBlock {
        param([string]$root, [string]$workdir, [string]$desktopUser)
        $ErrorActionPreference = 'Stop'
        $compiler = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
        $helper = Join-Path $root 'Helper.exe'
        $sources = @('Helper.cs', 'Job.cs', 'Desktop.cs') | ForEach-Object { Join-Path $root $_ }
        $output = & $compiler /nologo /target:winexe /optimize+ /platform:anycpu "/out:$helper" /r:System.Web.Extensions.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll @sources 2>&1
        if ($LASTEXITCODE -ne 0) { throw ('The guest helper failed to compile. ' + ($output -join ' ')) }

        $shellUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
        $shellPrincipal = New-ScheduledTaskPrincipal -UserId $shellUser -LogonType S4U -RunLevel Limited
        $shellAction = New-ScheduledTaskAction -Execute $helper -Argument 'shell "$(Arg0)"'
        $shellSettings = New-ScheduledTaskSettingsSet -MultipleInstances Parallel -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
        Register-ScheduledTask -TaskName 'CsAgentHypervShellV1' -Action $shellAction -Principal $shellPrincipal -Settings $shellSettings -Force | Out-Null

        $desktopSid = $null
        if ($desktopUser) {
            $desktopSid = [Security.Principal.NTAccount]::new($desktopUser).Translate([Security.Principal.SecurityIdentifier]).Value
            $desktopPrincipal = New-ScheduledTaskPrincipal -UserId $desktopUser -LogonType Interactive -RunLevel Limited
            $desktopAction = New-ScheduledTaskAction -Execute $helper -Argument 'desktop "$(Arg0)"'
            $desktopSettings = New-ScheduledTaskSettingsSet -MultipleInstances Queue -ExecutionTimeLimit ([TimeSpan]::FromMinutes(1)) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
            Register-ScheduledTask -TaskName 'CsAgentHypervDesktopV1' -Action $desktopAction -Principal $desktopPrincipal -Settings $desktopSettings -Force | Out-Null
        } elseif (Get-ScheduledTask -TaskName 'CsAgentHypervDesktopV1' -ErrorAction SilentlyContinue) {
            Unregister-ScheduledTask -TaskName 'CsAgentHypervDesktopV1' -Confirm:$false
        }

        $setup = @{
            version = 1
            bridgeSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
            workdir = [IO.Path]::GetFullPath($workdir)
            desktopUser = $desktopUser
            desktopSid = $desktopSid
        } | ConvertTo-Json -Compress
        [IO.File]::WriteAllText((Join-Path $root 'settings.json'), $setup, [Text.UTF8Encoding]::new($false))
    }
    Write-Output 'Hyper-V guest helper prepared.'
} finally {
    if ($session) { Remove-PSSession -Session $session }
}
