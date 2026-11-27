# Coffee Lounge uninstaller (WINDOWS_DEPLOYMENT.md §8). Removes the services, firewall
# rules and program files. Keeps the database, logs, files and settings in the data
# folder unless -RemoveData is given together with -ConfirmShopName (typed by the owner).
param(
  [string]$InstallDir = '',
  [string]$DataDir = '',
  [switch]$RemoveData,
  [string]$ConfirmShopName = ''
)
. (Join-Path $PSScriptRoot 'lib.ps1')
$location = Get-InstallLocation
if (-not $InstallDir) { $InstallDir = $location.InstallDir }
if (-not $DataDir) { $DataDir = $location.DataDir }

if (-not (Test-Admin)) { throw 'Run the uninstaller as an Administrator.' }
if ($RemoveData -and $ConfirmShopName -ne 'Coffee Lounge') {
  throw 'To remove the data, also pass -ConfirmShopName "Coffee Lounge". Make a backup first.'
}
$script:LogFile = Join-Path $env:TEMP ("coffeelounge-uninstall-{0}.log" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))

foreach ($s in @('coffeelounge-api', 'coffeelounge-worker')) {
  if (Get-Service -Name $s -ErrorAction SilentlyContinue) {
    Stop-Service -Name $s -Force
    $exe = Join-Path $InstallDir "services\$s.exe"
    if (Test-Path $exe) { Invoke-Native -FilePath $exe -Arguments @('uninstall') | Out-Null }
    else { Invoke-Native -FilePath 'sc.exe' -Arguments @('delete', $s) | Out-Null }
    Write-Step "Removed service $s"
  }
}
Unregister-ScheduledTask -TaskName 'Coffee Lounge database watchdog' -Confirm:$false -ErrorAction SilentlyContinue
# Our own PostgreSQL goes; one that was on this PC before stays untouched (our database inside it
# stays too, like the data folder).
$db = Get-DbConfig $DataDir
if (-not $db) { $db = [pscustomobject]@{ Mode = 'own'; Service = 'postgresql-x64-17'; PgDir = 'C:\Program Files\PostgreSQL\17' } }
$PgDir = $db.PgDir
if ($db.Mode -eq 'own' -and (Get-Service -Name $db.Service -ErrorAction SilentlyContinue)) {
  Stop-Service -Name $db.Service -Force
  Invoke-Native -FilePath (Join-Path $PgDir 'bin\pg_ctl.exe') -Arguments @('unregister', '-N', $db.Service) | Out-Null
  Write-Step "Removed service $($db.Service) (the database files stay)"
}
Get-NetFirewallRule -DisplayName 'CoffeeLounge *' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
Get-Process -Name 'CoffeeLounge' -ErrorAction SilentlyContinue | Stop-Process -Force
Unregister-ScheduledTask -TaskName 'Coffee Lounge updater' -Confirm:$false -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName 'Coffee Lounge counter app' -Confirm:$false -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName 'Coffee Lounge database watchdog' -Confirm:$false -ErrorAction SilentlyContinue
Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\Coffee Lounge.lnk')
Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path ([Environment]::GetFolderPath('CommonDesktopDirectory')) 'Coffee Lounge.lnk')
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\CoffeeLounge'
Write-Step 'Removed the counter app start-up task, shortcut and Add/Remove Programs entry'
$remove = @($InstallDir)
if ($db.Mode -eq 'own') { $remove += $PgDir }
# A PostgreSQL in the owner's folder leaves its empty version folder behind otherwise.
$ownParent = Split-Path -Parent $PgDir
foreach ($dir in $remove) {
  if (Test-Path $dir) { Remove-Item -Recurse -Force $dir; Write-Step "Removed $dir" }
}
if ($db.Mode -eq 'own' -and (Test-Path $ownParent) -and -not (Get-ChildItem $ownParent -Force)) { Remove-Item -Force $ownParent }
if ($RemoveData) {
  Remove-Item -Recurse -Force $DataDir
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $script:LocationKey
  Write-Step "Removed $DataDir (database, logs, files and settings)"
} else {
  Write-Step "Kept ${DataDir}: running the installer again picks up the same database."
}
Write-Step "Uninstall finished. Log: $script:LogFile"
