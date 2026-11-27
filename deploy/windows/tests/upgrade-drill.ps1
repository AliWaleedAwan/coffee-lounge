# W-1 and AT-45 in Windows CI (WINDOWS_DEPLOYMENT.md §7; step 7.4), on an installed shop:
# 1. PostgreSQL's own process killed: the watchdog starts it again within about a minute.
# 2. An upgrade to a build with one more migration: health green, the old version and the
#    database before it kept.
# 3. With a cash shift open, the upgrade is refused (nothing changed).
# 4. An upgrade whose migration fails (forced past the open shift): rolled back to the previous
#    version, the database as before, health green.
param(
  [Parameter(Mandatory)] [string]$BackupDrive,
  [string]$InstallDir = 'C:\Program Files\CoffeeLounge',
  [string]$PgDir = 'C:\Program Files\PostgreSQL\17',
  [string]$DataDir = 'C:\ProgramData\CoffeeLounge',
  [int]$PgPort = 5432
)
. (Join-Path $PSScriptRoot '..\lib.ps1')
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$Node = Join-Path $InstallDir 'runtime\node.exe'
$RootCa = Join-Path $DataDir 'config\tls\coffee-lounge-root.pem'
$Migrations = Join-Path $repo 'apps\server\migrations'

function Invoke-SuperSql([string]$Sql) {
  $env:PGPASSWORD = Unprotect-FromFile (Join-Path $DataDir 'config\postgres.secret')
  try { return (& (Join-Path $PgDir 'bin\psql.exe') -h 127.0.0.1 -p $PgPort -U postgres -d coffee_lounge -At -c $Sql) }
  finally { Remove-Item Env:\PGPASSWORD }
}
function Wait-Api {
  & $Node (Join-Path $InstallDir 'setup\wait-ready.mjs') 'https://127.0.0.1:8443/health/ready' $RootCa 180
  if ($LASTEXITCODE -ne 0) { throw 'the API is not ready' }
}
function Build-Variant([string]$Name, [hashtable]$Extra) {
  foreach ($f in $Extra.Keys) { Set-Content -Path (Join-Path $Migrations $f) -Value $Extra[$f] -Encoding ASCII }
  try {
    # A function returns whatever a child prints: send it to the console, return only the path.
    powershell -ExecutionPolicy Bypass -File (Join-Path $repo 'deploy\windows\build-bundle.ps1') -Out (Join-Path $repo "out\$Name") | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "building $Name failed" }
  } finally {
    foreach ($f in $Extra.Keys) { Remove-Item -Force (Join-Path $Migrations $f) }
  }
  return (Join-Path $repo "out\$Name")
}
function Install-From([string]$Bundle, [string[]]$More = @()) {
  powershell -ExecutionPolicy Bypass -File (Join-Path $Bundle 'setup\install.ps1') -Source $Bundle -Unattended -SkipHostSettings -BackupDrive $BackupDrive @More | Out-Host
  return $LASTEXITCODE
}
function Last-Log { Get-ChildItem (Join-Path $DataDir 'logs') -Filter 'install-*.log' | Sort-Object LastWriteTime | Select-Object -Last 1 | Get-Content -Raw }

# ---- 1. the watchdog (W-1)
$postmaster = Get-CimInstance Win32_Process -Filter "Name = 'postgres.exe'" | Where-Object {
  $parent = Get-CimInstance Win32_Process -Filter "ProcessId = $($_.ParentProcessId)" -ErrorAction SilentlyContinue
  -not $parent -or $parent.Name -ne 'postgres.exe'
} | Select-Object -First 1
if (-not $postmaster) { throw 'no PostgreSQL postmaster process found' }
Stop-Process -Id $postmaster.ProcessId -Force
for ($i = 0; $i -lt 50; $i++) {
  Start-Sleep -Seconds 5
  if ((Get-Service 'postgresql-x64-17').Status -eq 'Running' -and (Test-Path (Join-Path $DataDir 'logs\pg-watchdog.log'))) { break }
}
if ((Get-Service 'postgresql-x64-17').Status -ne 'Running') { throw 'PostgreSQL was not started again by the watchdog' }
Wait-Api
Write-Step ("Watchdog: " + (Get-Content (Join-Path $DataDir 'logs\pg-watchdog.log') -Tail 1))

# ---- 2. a good upgrade (AT-45)
$good = Build-Variant 'upgrade-good' @{ '9998_upgrade_drill.sql' = 'CREATE TABLE cl.upgrade_drill (id int);' }
if ((Install-From $good) -ne 0) { Write-Step (Last-Log); throw 'the upgrade failed' }
Wait-Api
if ((Invoke-SuperSql "SELECT to_regclass('cl.upgrade_drill') IS NOT NULL") -ne 't') { throw 'the new migration did not run' }
# Owner's request (Nov 2026): a successful update removes the old version.
if (Test-Path (Join-Path $DataDir 'previous-version')) { throw 'the previous version was left behind after a successful update' }
if (-not (Get-ChildItem (Join-Path $DataDir 'pre-upgrade') -Filter '*.dump')) { throw 'no pre-upgrade dump' }
Write-Step 'Upgrade: new migration applied, old version removed, pre-upgrade dump kept, API ready.'

# ---- 3. refused while a cash shift is open
Invoke-SuperSql "INSERT INTO cl.cash_shifts (till_id, cashier_user_id, opening_float) SELECT t.id, u.id, 0 FROM cl.tills t, cl.users u WHERE u.is_owner LIMIT 1" | Out-Null
if ((Install-From $good) -eq 0) { throw 'the upgrade went ahead with a cash shift open' }
if (-not ((Last-Log) -match 'Upgrade refused')) { throw 'no refusal message' }
Wait-Api
Write-Step 'Upgrade refused while a cash shift is open; the shop kept running.'

# ---- 4. a failing upgrade rolls back
$bad = Build-Variant 'upgrade-bad' @{
  '9998_upgrade_drill.sql' = 'CREATE TABLE cl.upgrade_drill (id int);'
  '9999_upgrade_fails.sql' = 'CREATE TABLE cl.half_done (id int); SELECT 1 / 0;'
}
if ((Install-From $bad @('-Force')) -eq 0) { throw 'a failing migration did not fail the upgrade' }
$log = Last-Log
if (-not ($log -match 'ROLLED BACK')) { Write-Step $log; throw 'no rollback' }
Wait-Api
if (Test-Path (Join-Path $InstallDir 'app\migrations\9999_upgrade_fails.sql')) { throw 'the failed version is still installed' }
if ((Invoke-SuperSql "SELECT max(version) FROM cl_meta.schema_migrations") -ne '9998') { throw 'the database is not as before the upgrade' }
if ((Invoke-SuperSql "SELECT to_regclass('cl.half_done') IS NULL") -ne 't') { throw 'the failed migration left a table' }
if ((Invoke-SuperSql "SELECT count(*) FROM cl.cash_shifts WHERE status = 'open'") -ne '1') { throw 'the data from before the upgrade is not back' }
Write-Step 'Failed upgrade: rolled back to the previous version and the database as before; API ready.'
