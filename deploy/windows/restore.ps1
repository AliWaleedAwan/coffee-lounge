# Restore to a point in time on this PC (BACKUP_RECOVERY.md §5.3, §5.4; step 7.3). Owner only:
# it needs the owner's USB key (the backup key) and a typed confirmation, because everything
# recorded after the chosen time is lost and must be entered again. Run as Administrator:
#
#   powershell -ExecutionPolicy Bypass -File setup\restore.ps1 -KeyFile E:\coffee-lounge-backup-key.txt [-PointInTime "2026-11-02 14:30"]
#
# Stops the services, keeps the current database folder (renamed, never deleted), unpacks the
# newest base backup before the time from the backup drive, lets PostgreSQL replay the archived
# WAL to that time, runs the integrity checks and starts the services again.
param(
  [Parameter(Mandatory)] [string]$KeyFile,
  [string]$PointInTime = 'latest',
  [string]$InstallDir = 'C:\Program Files\CoffeeLounge',
  [string]$PgDir = 'C:\Program Files\PostgreSQL\17',
  [string]$DataDir = 'C:\ProgramData\CoffeeLounge',
  [int]$PgPort = 5432,
  [switch]$Unattended
)
. (Join-Path $PSScriptRoot 'lib.ps1')

if (-not (Test-Admin)) { throw 'Run the restore as an Administrator.' }
$Node = Join-Path $InstallDir 'runtime\node.exe'
$Admin = Join-Path $InstallDir 'app\dist\admin.js'
$EnvFile = Join-Path $DataDir 'config\server.env'
$PgData = Join-Path $DataDir 'pgdata'
$PgService = 'postgresql-x64-17'
$AppServices = @('coffeelounge-api', 'coffeelounge-worker')
if (-not (Test-Path $KeyFile)) { throw "The backup key $KeyFile is not there: plug in the owner's USB key." }
$target = 'latest'
if ($PointInTime -ne 'latest') {
  $target = ([DateTimeOffset]::Parse($PointInTime)).ToString('o')
}
if (-not $Unattended) {
  Write-Host "Everything recorded after $PointInTime will be lost and must be entered again." -ForegroundColor Yellow
  $typed = Read-Host 'Type RESTORE to continue'
  if ($typed -ne 'RESTORE') { throw 'Not confirmed; nothing was changed.' }
}

Write-Step 'Stopping the services'
foreach ($s in $AppServices) { Stop-Service -Name $s -ErrorAction SilentlyContinue }
Stop-Service -Name $PgService
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$kept = "$PgData-before-restore-$stamp"
Rename-Item -Path $PgData -NewName (Split-Path $kept -Leaf)
Write-Step "The database folder before the restore is kept in $kept"
New-Item -ItemType Directory -Force -Path $PgData | Out-Null
# PostgreSQL's own account reads the key while it replays the WAL; the copy is removed after.
$replayKey = Join-Path $DataDir 'restore-key.txt'
Copy-Item $KeyFile $replayKey -Force
Set-RestrictedAcl -Path $replayKey -Read @('NT AUTHORITY\NETWORK SERVICE')
try {
  Invoke-Native -FilePath $Node -Arguments @("--env-file=$EnvFile", $Admin, 'restore-prepare', '--key', $replayKey, '--to', $PgData, '--time', $target) | Out-Null
  Set-RestrictedAcl -Path $PgData -Modify @('NT AUTHORITY\NETWORK SERVICE')
  Invoke-Native -FilePath 'icacls.exe' -Arguments @($PgData, '/grant', 'NT AUTHORITY\NETWORK SERVICE:(OI)(CI)M', '/T', '/Q') | Out-Null
  Write-Step 'Starting PostgreSQL to replay the archived changes'
  try {
    Start-Service -Name $PgService
  } catch {
    # An early failure (before PostgreSQL's own log starts) is only in the Windows event log.
    Get-WinEvent -LogName Application -MaxEvents 40 -ErrorAction SilentlyContinue |
      Where-Object { $_.ProviderName -like 'PostgreSQL*' -or $_.ProviderName -like 'postgresql*' } |
      Select-Object -First 10 | ForEach-Object { Write-Step "  event: $($_.Message)" }
    $log = Get-ChildItem (Join-Path $PgData 'log') -ErrorAction SilentlyContinue | Sort-Object LastWriteTime | Select-Object -Last 1
    if ($log) { Get-Content $log.FullName -Tail 15 | ForEach-Object { Write-Step "  pg log: $_" } }
    Get-Content (Join-Path $PgData 'postgresql.auto.conf') | ForEach-Object { Write-Step "  auto.conf: $_" }
    throw
  }
  $super = Unprotect-FromFile (Join-Path $DataDir 'config\postgres.secret')
  $env:PGPASSWORD = $super
  try {
    $done = $false
    for ($i = 0; $i -lt 300; $i++) {
      $state = & (Join-Path $PgDir 'bin\psql.exe') -h 127.0.0.1 -p $PgPort -U postgres -d postgres -At -c 'SELECT pg_is_in_recovery()' 2>$null
      if ($state -eq 'f') { $done = $true; break }
      Start-Sleep -Seconds 2
    }
  } finally { Remove-Item Env:\PGPASSWORD }
  if (-not $done) { throw 'PostgreSQL did not finish replaying within 10 minutes; see its log in pgdata\log' }
} finally {
  Remove-Item -Force $replayKey -ErrorAction SilentlyContinue
}
Write-Step 'Integrity checks (BACKUP_RECOVERY.md §4)'
Invoke-Native -FilePath $Node -Arguments @("--env-file=$EnvFile", $Admin, 'integrity-check') | Out-Null
foreach ($s in $AppServices) { Start-Service -Name $s }
Write-Step "Restored to $PointInTime. The folder from before is $kept; remove it only once the shop has checked its records."
