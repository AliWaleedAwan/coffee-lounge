# DRILL-1 and AT-22 in Windows CI (BACKUP_RECOVERY.md §5, §7; step 7.3), after smoke.ps1 has
# made backups. 1. Point in time on this PC: marker A before the chosen time, marker B after;
# after restore.ps1, A is there and B is not, the old folder is kept, the services serve.
# 2. A replacement PC: everything removed (database, config), then a fresh install in Restore
# mode from the newest dump with the owner's USB key: the records, the owner, the shop root
# (staff devices keep trusting it) and the backup key all come back.
param(
  [Parameter(Mandatory)] [string]$UsbDir,
  [Parameter(Mandatory)] [string]$BackupDrive,
  [Parameter(Mandatory)] [string]$Setup,
  [string]$InstallDir = 'C:\Program Files\CoffeeLounge',
  [string]$PgDir = 'C:\Program Files\PostgreSQL\17',
  [string]$DataDir = 'C:\ProgramData\CoffeeLounge',
  [int]$PgPort = 5432
)
. (Join-Path $PSScriptRoot '..\lib.ps1')
$ErrorActionPreference = 'Stop'
$Node = Join-Path $InstallDir 'runtime\node.exe'
$Admin = Join-Path $InstallDir 'app\dist\admin.js'
$EnvFile = Join-Path $DataDir 'config\server.env'
$Key = Join-Path $UsbDir 'coffee-lounge-backup-key.txt'

function Invoke-SuperSql([string]$Sql) {
  $env:PGPASSWORD = Unprotect-FromFile (Join-Path $DataDir 'config\postgres.secret')
  try { return (& (Join-Path $PgDir 'bin\psql.exe') -h 127.0.0.1 -p $PgPort -U postgres -d coffee_lounge -At -c $Sql) }
  finally { Remove-Item Env:\PGPASSWORD }
}
function Marker([string]$Name) {
  & $Node "--env-file=$EnvFile" $Admin registration-code --name $Name --kind waiter --ownership shop | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "could not add $Name" }
}
function Count([string]$Name) { Invoke-SuperSql "SELECT count(*) FROM cl.device_registration_codes WHERE device_name = '$Name'" }

# ---- 1. point in time (§5.4)
Marker 'marker-A'
Invoke-SuperSql 'SELECT pg_switch_wal()' | Out-Null
Start-Sleep -Seconds 3
$cut = (Get-Date).ToUniversalTime().ToString('o')
Start-Sleep -Seconds 3
Marker 'marker-B'
Invoke-SuperSql 'SELECT pg_switch_wal()' | Out-Null
for ($i = 0; $i -lt 30; $i++) {
  if ((Invoke-SuperSql "SELECT last_archived_time > now() - interval '2 seconds' OR last_archived_wal IS NOT NULL FROM pg_stat_archiver") -eq 't') { break }
  Start-Sleep -Seconds 2
}
Start-Sleep -Seconds 5
powershell -ExecutionPolicy Bypass -File (Join-Path $InstallDir 'setup\restore.ps1') -KeyFile $Key -PointInTime $cut -Unattended
if ($LASTEXITCODE -ne 0) { throw 'restore.ps1 failed' }
if ((Count 'marker-A') -ne '1') { throw 'marker A (before the time) is missing after the restore' }
if ((Count 'marker-B') -ne '0') { throw 'marker B (after the time) came back: the restore did not stop at the time' }
if (-not (Get-ChildItem $DataDir -Directory -Filter 'pgdata-before-restore-*')) { throw 'the folder from before was not kept' }
if (Test-Path (Join-Path $DataDir 'restore-key.txt')) { throw 'the replay copy of the key was left on the PC' }
& $Node (Join-Path $InstallDir 'setup\wait-ready.mjs') 'https://127.0.0.1:8443/health/ready' (Join-Path $DataDir 'config\tls\coffee-lounge-root.pem') 120
if ($LASTEXITCODE -ne 0) { throw 'the API is not ready after the point-in-time restore' }
Write-Step 'Point-in-time restore: marker A kept, marker B gone, old folder kept, API ready.'

# ---- 2. a replacement PC (§5.1, AT-22)
& $Node "--env-file=$EnvFile" $Admin backup-now | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'backup-now before the replacement failed' }
$users = Invoke-SuperSql 'SELECT count(*) FROM cl.users'
$rootBefore = Get-Content -Raw (Join-Path $DataDir 'config\tls\coffee-lounge-root.pem')
$pubBefore = Get-Content -Raw (Join-Path $DataDir 'config\backup.pub')
powershell -ExecutionPolicy Bypass -File (Join-Path $InstallDir 'setup\uninstall.ps1') -RemoveData -ConfirmShopName 'Coffee Lounge'
if ($LASTEXITCODE -ne 0) { throw 'uninstall failed' }
if (Test-Path (Join-Path $DataDir 'pgdata\PG_VERSION')) { throw 'the old database is still there: not a clean PC' }
$p = Start-Process -FilePath $Setup -ArgumentList @('-Unattended', '-SkipHostSettings', '-CaExportDir', $UsbDir, '-BackupDrive', $BackupDrive, '-RestoreFrom', 'latest') -Wait -PassThru
Get-ChildItem (Join-Path $DataDir 'logs') -Filter 'install-*.log' | Sort-Object LastWriteTime | Select-Object -Last 1 | Get-Content -Tail 40
if ($p.ExitCode -ne 0) { throw "install in Restore mode failed ($($p.ExitCode))" }
if ((Invoke-SuperSql 'SELECT count(*) FROM cl.users') -ne $users) { throw 'the users did not come back' }
if ((Count 'marker-A') -ne '1') { throw 'marker A did not come back on the replacement PC' }
if ((Get-Content -Raw (Join-Path $DataDir 'config\tls\coffee-lounge-root.pem')) -ne $rootBefore) { throw 'a new shop root: staff devices would stop trusting the server' }
if ((Get-Content -Raw (Join-Path $DataDir 'config\backup.pub')) -ne $pubBefore) { throw 'a new backup key: old backups would not open' }
& $Node "--env-file=$EnvFile" $Admin integrity-check
if ($LASTEXITCODE -ne 0) { throw 'integrity checks failed on the replacement PC' }
& $Node (Join-Path $InstallDir 'setup\wait-ready.mjs') 'https://127.0.0.1:8443/health/ready' (Join-Path $DataDir 'config\tls\coffee-lounge-root.pem') 120
if ($LASTEXITCODE -ne 0) { throw 'the API is not ready on the replacement PC' }
Write-Step 'Replacement PC: records, owner, shop root and backup key restored; integrity checks pass; API ready.'
