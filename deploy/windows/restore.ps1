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
  [string]$InstallDir = '',
  [string]$DataDir = '',
  [switch]$Unattended
)
. (Join-Path $PSScriptRoot 'lib.ps1')
$location = Get-InstallLocation
if (-not $InstallDir) { $InstallDir = $location.InstallDir }
if (-not $DataDir) { $DataDir = $location.DataDir }

if (-not (Test-Admin)) { throw 'Run the restore as an Administrator.' }
$Node = Join-Path $InstallDir 'runtime\node.exe'
$Admin = Join-Path $InstallDir 'app\dist\admin.js'
$EnvFile = Join-Path $DataDir 'config\server.env'
$db = Get-DbConfig $DataDir
if (-not $db) { $db = [pscustomobject]@{ Mode = 'own'; Service = 'postgresql-x64-17'; Port = 5432; PgDir = 'C:\Program Files\PostgreSQL\17'; DataDir = (Join-Path $DataDir 'pgdata') } }
# A point-in-time restore replaces the whole PostgreSQL, and with it the other programs' data.
if ($db.Mode -eq 'shared') {
  throw 'This shop uses the PostgreSQL that was already on this PC, which other programs share, so it cannot be rewound as a whole. Restore the nightly copy instead: run the setup with -RestoreFrom latest (BACKUP_RECOVERY.md).'
}
$PgData = $db.DataDir
$PgService = $db.Service
$PgPort = [int]$db.Port
$PgDir = $db.PgDir
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

# The watchdog must not start PostgreSQL while the restore has it stopped.
$flag = Join-Path $DataDir 'maintenance.flag'
New-Item -ItemType File -Force -Path $flag | Out-Null
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
Set-RestrictedAcl -Path $replayKey -Read @('*S-1-5-20')
try {
  Invoke-Native -FilePath $Node -Arguments @("--env-file=$EnvFile", $Admin, 'restore-prepare', '--key', $replayKey, '--to', $PgData, '--time', $target) | Out-Null
  Set-RestrictedAcl -Path $PgData -Modify @('*S-1-5-20')
  Invoke-Native -FilePath 'icacls.exe' -Arguments @($PgData, '/grant', '*S-1-5-20:(OI)(CI)M', '/T', '/Q') | Out-Null
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
Remove-Item -Force $flag -ErrorAction SilentlyContinue
Write-Step "Restored to $PointInTime. The folder from before is $kept; remove it only once the shop has checked its records."
