# Coffee Lounge uninstaller (WINDOWS_DEPLOYMENT.md §8). Removes the services, firewall
# rules and program files. Keeps the database, logs, files and settings in the data
# folder unless -RemoveData is given together with -ConfirmShopName (typed by the owner).
param(
  [string]$InstallDir = 'C:\Program Files\CoffeeLounge',
  [string]$PgDir = 'C:\Program Files\PostgreSQL\17',
  [string]$DataDir = 'C:\ProgramData\CoffeeLounge',
  [switch]$RemoveData,
  [string]$ConfirmShopName = ''
)
. (Join-Path $PSScriptRoot 'lib.ps1')

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
if (Get-Service -Name 'postgresql-x64-17' -ErrorAction SilentlyContinue) {
  Stop-Service -Name 'postgresql-x64-17' -Force
  Invoke-Native -FilePath (Join-Path $PgDir 'bin\pg_ctl.exe') -Arguments @('unregister', '-N', 'postgresql-x64-17') | Out-Null
  Write-Step 'Removed service postgresql-x64-17 (the database files stay)'
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
foreach ($dir in @($InstallDir, $PgDir)) {
  if (Test-Path $dir) { Remove-Item -Recurse -Force $dir; Write-Step "Removed $dir" }
}
if ($RemoveData) {
  Remove-Item -Recurse -Force $DataDir
  Write-Step "Removed $DataDir (database, logs, files and settings)"
} else {
  Write-Step "Kept ${DataDir}: running the installer again picks up the same database."
}
Write-Step "Uninstall finished. Log: $script:LogFile"
