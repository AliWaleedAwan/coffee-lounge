# Coffee Lounge installer skeleton (WINDOWS_DEPLOYMENT.md §1, §2, §3, §6). Run as an
# Administrator from the bundle's setup folder. Safe to run again: an existing database,
# secrets and certificates are kept (that is also the upgrade path).
#
#   powershell -ExecutionPolicy Bypass -File setup\install.ps1 -CaExportDir E:\CoffeeLounge-Keys
#
# First install needs -CaExportDir: a folder the owner keeps (a USB key is best). The shop CA's
# private key is written there and removed from this PC. An existing PostgreSQL 17 is used, with
# its postgres password in CL_PG_SUPERPASSWORD; otherwise our own copy (lib.ps1 Resolve-DbPlan). Not automated: static IP and network
# profile (H-1, H-2), test print and setup sheet (Phase 3/7).
param(
  [string]$Source = (Split-Path -Parent $PSScriptRoot),
  # Empty: where this PC has it already, else the owner's folder (CL_INSTALL_BASE), else the defaults.
  [string]$InstallDir = '',
  [string]$DataDir = '',
  [string]$ShopIp = '192.168.100.250',
  [string]$CaExportDir = '',
  # Unattended installs only (tests); otherwise typed without echo.
  [string]$CaPassphrase = '',
  # Windows account the counter app starts for at login (H-9, H-11).
  [string]$CounterUser = 'Counter',
  # The backup drive's root (BACKUP_RECOVERY.md §3: the CL-BACKUP drive at B:\). Tests use a folder.
  [string]$BackupDrive = 'B:\',
  # Restore mode on a replacement PC (BACKUP_RECOVERY.md §5.1, step 7.3): 'latest' or a dump file,
  # with the owner's USB key in -CaExportDir (its backup key and shop root are reused).
  [string]$RestoreFrom = '',
  # Upgrade even while bills or a cash shift are open (the owner's decision; step 7.4).
  [switch]$Force,
  # Leave power, time zone, Defender and Remote Desktop alone (test machines, CI).
  [switch]$SkipHostSettings,
  [switch]$Unattended,
  # Run by the setup wizard: the owner's password comes in CL_OWNER_PASSWORD (Phase 8 step 8.4).
  [switch]$Wizard
)
. (Join-Path $PSScriptRoot 'lib.ps1')

$location = Resolve-InstallLocation $env:CL_INSTALL_BASE
if (-not $InstallDir) { $InstallDir = $location.InstallDir }
if (-not $DataDir) { $DataDir = $location.DataDir }

$AppServices = @('coffeelounge-api', 'coffeelounge-worker')
$Database = 'coffee_lounge'
$Config = Join-Path $DataDir 'config'
$Tls = Join-Path $Config 'tls'
$Node = Join-Path $InstallDir 'runtime\node.exe'

if (-not (Test-Admin)) { throw 'Run the installer as an Administrator.' }
if (-not [Environment]::Is64BitProcess) { throw 'Run the installer in 64-bit PowerShell.' }
# Unattended runs through CoffeeLounge-Setup.exe pass the CA passphrase in the environment.
if (-not $CaPassphrase -and $env:CL_CA_PASSPHRASE) { $CaPassphrase = $env:CL_CA_PASSPHRASE }
if (-not $CaExportDir -and $env:CL_CA_EXPORT_DIR) { $CaExportDir = $env:CL_CA_EXPORT_DIR }
# The counter app's settings stay where Windows apps look for them, whatever the owner's folder.
$desktopDir = Join-Path $env:ProgramData 'CoffeeLounge\desktop'
foreach ($d in @($DataDir, $Config, (Join-Path $DataDir 'logs'), (Join-Path $DataDir 'files'), $desktopDir)) {
  New-Item -ItemType Directory -Force -Path $d | Out-Null
}
$script:LogFile = Join-Path $DataDir ("logs\install-{0}.log" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
# Any failure from here on is written to the install log too (the console may close).
trap {
  Write-Step ("INSTALL FAILED: {0}`n{1}" -f $_.Exception.Message, $_.InvocationInfo.PositionMessage)
  if ($script:UpgradeArmed) { Invoke-Rollback }
  exit 1
}
$script:UpgradeArmed = $false

# Which PostgreSQL: decided on the first install and kept (lib.ps1).
Set-InstallLocation $InstallDir $DataDir
Write-Step "Program in $InstallDir, data in $DataDir"
$Db = Resolve-DbPlan $DataDir ($env:CL_PG_MODE -eq 'own') $InstallDir
$Shared = $Db.Mode -eq 'shared'
$PgService = $Db.Service
$PgPort = [int]$Db.Port
$PgDir = $Db.PgDir
$PgData = $Db.DataDir
$PgAccount = $Db.Account
$Psql = Join-Path $PgDir 'bin\psql.exe'
$MaintenanceFlag = Join-Path $DataDir 'maintenance.flag'
$Previous = Join-Path $DataDir 'previous-version'
$PreUpgradeDir = Join-Path $DataDir 'pre-upgrade'

# WINDOWS_DEPLOYMENT.md §7 (step 7.4): if an upgrade fails at any point, the previous program
# files and the database as it was just before are put back, and the old version is started.
function Invoke-Rollback {
  $script:UpgradeArmed = $false
  try {
    Write-Step 'Rolling back to the previous version'
    foreach ($s in $AppServices) { Stop-Service -Name $s -Force -ErrorAction SilentlyContinue }
    foreach ($part in @('app', 'web', 'runtime', 'winsw', 'setup', 'desktop')) {
      & robocopy.exe (Join-Path $Previous $part) (Join-Path $InstallDir $part) /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
    }
    Copy-Item (Join-Path $Previous 'VERSION.txt') $InstallDir -Force
    if (-not $Shared) { & robocopy.exe (Join-Path $Previous 'pgsql') $PgDir /MIR /NFL /NDL /NJH /NJS /NP | Out-Null }
    if ((Get-Service -Name $PgService).Status -ne 'Running') { Start-Service -Name $PgService }
    $dump = Get-ChildItem $PreUpgradeDir -Filter '*.dump' | Sort-Object Name | Select-Object -Last 1
    $super = Unprotect-FromFile (Join-Path $Config 'postgres.secret')
    $env:PGPASSWORD = $super
    try {
      & (Join-Path $PgDir 'bin\psql.exe') -h 127.0.0.1 -p $PgPort -U postgres -d postgres -v ON_ERROR_STOP=1 -q -c "DROP DATABASE IF EXISTS $Database WITH (FORCE)" | Out-Null
      & (Join-Path $PgDir 'bin\psql.exe') -h 127.0.0.1 -p $PgPort -U postgres -d postgres -v ON_ERROR_STOP=1 -q -c "CREATE DATABASE $Database OWNER cl_migrator ENCODING 'UTF8' TEMPLATE template0" | Out-Null
      & (Join-Path $PgDir 'bin\psql.exe') -h 127.0.0.1 -p $PgPort -U postgres -d postgres -v ON_ERROR_STOP=1 -q -c "REVOKE CONNECT ON DATABASE $Database FROM PUBLIC; GRANT CONNECT ON DATABASE $Database TO cl_service" | Out-Null
      & (Join-Path $PgDir 'bin\pg_restore.exe') -h 127.0.0.1 -p $PgPort -U postgres -d $Database --exit-on-error $dump.FullName
      if ($LASTEXITCODE -ne 0) { throw "pg_restore of $($dump.FullName) failed" }
    } finally { Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue }
    foreach ($s in $AppServices) { Start-Service -Name $s }
    & (Join-Path $InstallDir 'runtime\node.exe') (Join-Path $InstallDir 'setup\wait-ready.mjs') 'https://127.0.0.1:8443/health/ready' (Join-Path $Tls 'coffee-lounge-root.pem') '180'
    Write-Step "ROLLED BACK: the previous version runs again with the data as it was before the upgrade ($($dump.Name))."
  } catch {
    Write-Step "ROLLBACK FAILED: $($_.Exception.Message). Restore with setup\restore.ps1 or the dump in $PreUpgradeDir."
  } finally {
    Remove-Item -Force $MaintenanceFlag -ErrorAction SilentlyContinue
  }
}
Write-Step "Coffee Lounge install from $Source"
Write-Step (Get-Content -Raw (Join-Path $Source 'VERSION.txt'))

# ------------------------------------------------------------------ 1. checks
$firstInstall = -not (Test-Path (Join-Path $Config 'server.env'))
$needCertificates = -not (Test-Path (Join-Path $Tls 'server.pem'))
if (-not [Environment]::Is64BitOperatingSystem) { throw 'A 64-bit Windows is required.' }
# The drive that holds the data (the owner's folder), not necessarily C:.
$dataDrive = (Split-Path -Qualifier $DataDir).TrimEnd(':')
$freeGb = [math]::Floor((Get-PSDrive -Name $dataDrive).Free / 1GB)
# Owner's decision (Nov 2026): 10 GB. The program takes about 1 GB; the shop's data grows slowly.
if ($freeGb -lt 10) { throw "Not enough free disk space: 10 GB is needed, $freeGb GB is free. Free up space on drive $($dataDrive): and try again." }
if ($needCertificates -and -not $CaExportDir) {
  throw 'First install: pass -CaExportDir with the owner''s USB key folder for the shop CA key.'
}
$ourServicesExist = [bool](Get-Service -Name $AppServices -ErrorAction SilentlyContinue)
if (-not $ourServicesExist) {
  foreach ($port in @(8080, 8443)) { if (-not (Test-PortFree $port)) { throw "Port $port is in use by another program." } }
}
$pgServiceObj = Get-Service -Name $PgService -ErrorAction SilentlyContinue
if ($Shared) {
  if (-not $pgServiceObj) { throw "The PostgreSQL service $PgService chosen on the first install is gone." }
  Write-Step "Using the PostgreSQL 17 already on this PC (service $PgService, port $PgPort)"
} elseif (-not $pgServiceObj -and -not (Test-PortFree $PgPort)) {
  throw "Port $PgPort is in use by another program; the database needs it."
} else {
  Write-Step "Our own PostgreSQL 17: service $PgService, port $PgPort, in $PgDir"
}
# Kept from now on, so a retry or an upgrade makes the same choice.
Write-Utf8NoBom (Join-Path $Config 'database.json') (@{ Mode = $Db.Mode; Service = $PgService; Port = $PgPort; PgDir = $PgDir; DataDir = $PgData; Account = $PgAccount } | ConvertTo-Json)

# ------------------------------------------------------------------ 1b. upgrade (step 7.4)
$upgrading = (-not $firstInstall) -and (Test-Path (Join-Path $InstallDir 'app')) -and $pgServiceObj -and ($pgServiceObj.Status -eq 'Running')
if ($upgrading) {
  $superNow = Unprotect-FromFile (Join-Path $Config 'postgres.secret')
  $env:PGPASSWORD = $superNow
  try {
    $openWork = (& $Psql -h 127.0.0.1 -p $PgPort -U postgres -d $Database -At -c "SELECT (SELECT count(*) FROM cl.invoices WHERE status <> 'settled' AND total > 0) + (SELECT count(*) FROM cl.cash_shifts WHERE status = 'open')").Trim()
  } finally { Remove-Item Env:\PGPASSWORD }
  if ($openWork -ne '0' -and -not $Force) {
    throw "Upgrade refused: $openWork open bills or cash shifts. Settle them and close the shift first (or run with -Force if the owner decides so)."
  }
  New-Item -ItemType File -Force -Path $MaintenanceFlag | Out-Null
  # The database just before (in this PC's protected data folder; the last three are kept).
  New-Item -ItemType Directory -Force -Path $PreUpgradeDir | Out-Null
  Set-RestrictedAcl -Path $PreUpgradeDir
  $preDump = Join-Path $PreUpgradeDir ("pre-upgrade-{0}.dump" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
  $env:PGPASSWORD = $superNow
  try {
    & (Join-Path $PgDir 'bin\pg_dump.exe') -h 127.0.0.1 -p $PgPort -U postgres -d $Database --format=custom --file=$preDump
    if ($LASTEXITCODE -ne 0) { throw 'The pre-upgrade dump failed: nothing was changed.' }
    & (Join-Path $PgDir 'bin\pg_restore.exe') --list $preDump | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'The pre-upgrade dump does not read back: nothing was changed.' }
  } finally { Remove-Item Env:\PGPASSWORD }
  Get-ChildItem $PreUpgradeDir -Filter '*.dump' | Sort-Object Name | Select-Object -SkipLast 3 | Remove-Item -Force
  Write-Step "Pre-upgrade dump: $preDump"
  # The program as it is now, to go back to.
  foreach ($s in $AppServices) { if (Get-Service -Name $s -ErrorAction SilentlyContinue) { Stop-Service -Name $s -Force } }
  foreach ($part in @('app', 'web', 'runtime', 'winsw', 'setup', 'desktop')) {
    & robocopy.exe (Join-Path $InstallDir $part) (Join-Path $Previous $part) /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw 'Could not keep a copy of the current version: nothing was changed.' }
  }
  Copy-Item (Join-Path $InstallDir 'VERSION.txt') $Previous -Force
  if (-not $Shared) { & robocopy.exe $PgDir (Join-Path $Previous 'pgsql') /MIR /NFL /NDL /NJH /NJS /NP | Out-Null }
  Write-Step "The current version is kept in $Previous"
  $script:UpgradeArmed = $true
}

# ------------------------------------------------------------------ 2. program files
foreach ($s in $AppServices) {
  if (Get-Service -Name $s -ErrorAction SilentlyContinue) { Stop-Service -Name $s -Force; Write-Step "Stopped $s" }
}
function Copy-Tree([string]$From, [string]$To) {
  # robocopy: exit codes below 8 mean success.
  & robocopy.exe $From $To /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "Copying $From to $To failed (robocopy $LASTEXITCODE)" }
}
# A running counter app keeps its files open.
Get-Process -Name 'CoffeeLounge' -ErrorAction SilentlyContinue | Stop-Process -Force
Write-Step "Copying program files to $InstallDir"
foreach ($part in @('app', 'web', 'runtime', 'winsw', 'setup', 'desktop')) { Copy-Tree (Join-Path $Source $part) (Join-Path $InstallDir $part) }
Copy-Item (Join-Path $Source 'VERSION.txt') $InstallDir -Force

# ------------------------------------------------------------------ 3. PostgreSQL
$superSecret = Join-Path $Config 'postgres.secret'
if ($Shared) {
  # Someone else's PostgreSQL: its files and service stay as they are.
  if ($pgServiceObj.Status -ne 'Running') { Start-Service -Name $PgService }
  if (-not (Test-Path $superSecret)) {
    if (-not $env:CL_PG_SUPERPASSWORD) { throw 'This PC already has PostgreSQL 17: enter its postgres password in the wizard.' }
    Protect-ToFile $env:CL_PG_SUPERPASSWORD $superSecret
  }
} else {
  if ($pgServiceObj -and $pgServiceObj.Status -eq 'Running') { Stop-Service -Name $PgService -Force }
  Write-Step "Copying PostgreSQL to $PgDir"
  Copy-Tree (Join-Path $Source 'pgsql') $PgDir
  if (-not (Test-Path (Join-Path $PgData 'PG_VERSION'))) {
    # A folder left by an install that stopped half way is started again.
    if (Test-Path $PgData) { Remove-Item -Recurse -Force $PgData }
    Write-Step "Creating the database cluster in $PgData"
    New-Item -ItemType Directory -Force -Path $PgData | Out-Null
    $superPassword = New-Secret
    $pwFile = Join-Path $Config 'initdb.pw'
    Set-Content -Path $pwFile -Value $superPassword -NoNewline -Encoding ASCII
    try {
      Invoke-Native -FilePath (Join-Path $PgDir 'bin\initdb.exe') -Arguments @(
        '-D', $PgData, '-U', 'postgres', "--pwfile=$pwFile", '-E', 'UTF8', '--locale=C', '-A', 'scram-sha-256'
      ) | Out-Null
    } finally { Remove-Item -Force $pwFile }
    Protect-ToFile $superPassword $superSecret
    # H-8: no UPS, so committed data must reach the disk itself (write-through), and the
    # server only listens on this PC (LOCAL_LAN_HOSTING.md §4).
    Add-Content -Path (Join-Path $PgData 'postgresql.conf') -Value @'

# --- Coffee Lounge ---
listen_addresses = 'localhost'
# Flush each commit through to the disk (H-8). fsync_writethrough is not accepted by
# this PostgreSQL build; the power-cut drill measures the choice on the iMac.
wal_sync_method = fsync
fsync = on
full_page_writes = on
logging_collector = on
log_directory = 'log'
log_filename = 'postgresql-%a.log'
log_truncate_on_rotation = on
log_rotation_age = 1d
'@
    Add-Content -Path (Join-Path $PgData 'postgresql.conf') -Value "port = $PgPort"
    Set-Content -Path (Join-Path $PgData 'pg_hba.conf') -Encoding ASCII -Value @'
# Coffee Lounge: password logins from this PC only.
host all all 127.0.0.1/32 scram-sha-256
host all all ::1/128      scram-sha-256
'@
  }
  Set-RestrictedAcl -Path $PgData -Modify @($PgAccount)
  # initdb may leave explicit permissions on files inside: grant the service account
  # down the whole tree, as the EDB installer does.
  Invoke-Native -FilePath 'icacls.exe' -Arguments @($PgData, '/grant', "$($PgAccount):(OI)(CI)M", '/T', '/Q') | Out-Null
  if (-not $pgServiceObj) {
    Invoke-Native -FilePath (Join-Path $PgDir 'bin\pg_ctl.exe') -Arguments @(
      'register', '-N', $PgService, '-U', 'NT AUTHORITY\NetworkService', '-D', $PgData, '-S', 'auto', '-w'
    ) | Out-Null
  }
  Invoke-Native -FilePath 'sc.exe' -Arguments @('failure', $PgService, 'reset=', '86400', 'actions=', 'restart/10000/restart/30000/restart/60000') | Out-Null
  try {
    Start-Service -Name $PgService
  } catch {
    Show-ServiceFailure $PgService @('PostgreSQL', 'postgres')
    $pgLog = Join-Path $PgData 'log'
    if (Test-Path $pgLog) { Get-ChildItem $pgLog | ForEach-Object { Write-Step "--- $($_.Name)"; Write-Step (Get-Content -Raw $_.FullName) } }
    throw
  }
}
$superPassword = Unprotect-FromFile $superSecret
for ($i = 0; $i -lt 30; $i++) {
  & (Join-Path $PgDir 'bin\pg_isready.exe') -h 127.0.0.1 -p $PgPort | Out-Null
  if ($LASTEXITCODE -eq 0) { break }
  Start-Sleep -Seconds 2
}
$savedPreference = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$env:PGPASSWORD = $superPassword
try { $probe = (& $Psql -h 127.0.0.1 -p $PgPort -U postgres -d postgres -At -c 'SHOW server_version_num' 2>&1 | ForEach-Object { "$_" }) -join ' ' }
finally { Remove-Item Env:\PGPASSWORD; $ErrorActionPreference = $savedPreference }
if ($probe -notmatch '^17\d{4}$') {
  # A wrong password must be asked again, not kept.
  if ($Shared) { Remove-Item -Force $superSecret }
  throw "Cannot use PostgreSQL on port $PgPort as postgres ($probe). If this PC's own PostgreSQL 17 is used, check its postgres password and run the setup again."
}

function Invoke-Sql([string]$User, [string]$Password, [string]$Db, [string]$Sql, [string[]]$Hide = @()) {
  Invoke-Native -FilePath $Psql -Arguments @('-h', '127.0.0.1', '-p', "$PgPort", '-U', $User, '-d', $Db, '-v', 'ON_ERROR_STOP=1', '-q', '-f', '-') `
    -InputText $Sql -Hide ($Hide + @($Password)) -Environment @{ PGPASSWORD = $Password } | Out-Null
}

# ------------------------------------------------------------------ 4. logins and database
$migratorSecret = Join-Path $Config 'migrator.secret'
$serviceSecret = Join-Path $Config 'service.secret'
# Safe to repeat: an install that stopped half way may have made some of these already.
function Set-Login([string]$Name, [string]$Options, [string]$Password) {
  $verb = 'CREATE'
  $env:PGPASSWORD = $superPassword
  try { if ((& $Psql -h 127.0.0.1 -p $PgPort -U postgres -d postgres -At -c "SELECT 1 FROM pg_roles WHERE rolname = '$Name'") -eq '1') { $verb = 'ALTER' } }
  finally { Remove-Item Env:\PGPASSWORD }
  Invoke-Sql 'postgres' $superPassword 'postgres' "$verb ROLE $Name $Options PASSWORD '$Password';" @($Password)
}
function New-DatabaseIfMissing([string]$Name, [string]$Owner) {
  $env:PGPASSWORD = $superPassword
  try { $exists = (& $Psql -h 127.0.0.1 -p $PgPort -U postgres -d postgres -At -c "SELECT 1 FROM pg_database WHERE datname = '$Name'") -eq '1' }
  finally { Remove-Item Env:\PGPASSWORD }
  if (-not $exists) { Invoke-Sql 'postgres' $superPassword 'postgres' "CREATE DATABASE $Name OWNER $Owner ENCODING 'UTF8' TEMPLATE template0;" }
}
if (-not (Test-Path $migratorSecret)) {
  $migratorPassword = New-Secret
  $servicePassword = New-Secret
  Write-Step 'Creating the database and its logins'
  Set-Login 'cl_migrator' 'LOGIN CREATEROLE' $migratorPassword
  Set-Login 'cl_service' 'LOGIN' $servicePassword
  New-DatabaseIfMissing $Database 'cl_migrator'
  Invoke-Sql 'postgres' $superPassword 'postgres' "REVOKE CONNECT ON DATABASE $Database FROM PUBLIC; GRANT CONNECT ON DATABASE $Database TO cl_service;"
  Protect-ToFile $migratorPassword $migratorSecret
  Protect-ToFile $servicePassword $serviceSecret
}
$migratorPassword = Unprotect-FromFile $migratorSecret
$servicePassword = Unprotect-FromFile $serviceSecret

Write-Step 'Applying migrations'
Invoke-Native -FilePath $Node -Arguments @((Join-Path $InstallDir 'app\dist\migrate.js')) `
  -Environment @{ DATABASE_URL = "postgres://cl_migrator:$migratorPassword@127.0.0.1:$PgPort/$Database" } -Hide @($migratorPassword) | Out-Null
# The services log in as cl_service with the application role only (DATABASE.md §12, §15).
Invoke-Sql 'cl_migrator' $migratorPassword $Database 'GRANT cl_app TO cl_service;'

# The backup login (step 7.2): REPLICATION for base backups, and the owner of the scratch
# database the weekly test restore uses. It cannot read or change the shop's data otherwise.
$backupSecret = Join-Path $Config 'backup-login.secret'
if (-not (Test-Path $backupSecret)) {
  $backupPassword = New-Secret
  Set-Login 'cl_backup' 'LOGIN REPLICATION' $backupPassword
  New-DatabaseIfMissing 'coffee_lounge_restore_test' 'cl_backup'
  Invoke-Sql 'postgres' $superPassword 'coffee_lounge_restore_test' 'CREATE EXTENSION IF NOT EXISTS pg_trgm;'
  Protect-ToFile $backupPassword $backupSecret
}
$backupPassword = Unprotect-FromFile $backupSecret
$hba = Join-Path $PgData 'pg_hba.conf'
if (-not (Select-String -Path $hba -Pattern '^host\s+replication\s+cl_backup' -Quiet)) {
  Add-Content -Path $hba -Encoding ASCII -Value 'host replication cl_backup 127.0.0.1/32 scram-sha-256'
  Invoke-Sql 'postgres' $superPassword 'postgres' 'SELECT pg_reload_conf();'
}

# ------------------------------------------------------------------ 5. certificates
New-Item -ItemType Directory -Force -Path $Tls | Out-Null
if ($needCertificates) {
  if (-not $CaPassphrase) {
    if ($Unattended) { throw '-CaPassphrase is required for an unattended first install.' }
    $first = Read-Host -AsSecureString 'Choose a passphrase for the shop CA key (at least 12 characters)'
    $second = Read-Host -AsSecureString 'Repeat it'
    $CaPassphrase = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($first))
    $again = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($second))
    if ($CaPassphrase -ne $again) { throw 'The passphrases do not match.' }
  }
  $caTemp = Join-Path $Config 'ca-temp'
  New-Item -ItemType Directory -Force -Path $caTemp | Out-Null
  Set-RestrictedAcl -Path $caTemp
  try {
    $certs = Join-Path $InstallDir 'app\dist\certs.js'
    $caEnv = @{ CL_CA_PASSPHRASE = $CaPassphrase }
    $usbRoot = Join-Path $CaExportDir 'coffee-lounge-root.key'
    if ((Test-Path $usbRoot) -and (Test-Path (Join-Path $CaExportDir 'coffee-lounge-root.pem'))) {
      # A replacement PC: the shop root on the owner's USB key issues the new server certificate,
      # so every staff device that trusts the shop keeps trusting it (BACKUP_RECOVERY.md §5.1 step 6).
      Copy-Item (Join-Path $CaExportDir 'coffee-lounge-root.pem') $caTemp
      Copy-Item $usbRoot $caTemp
      Write-Step 'Using the shop root from the owner USB key'
    } else {
      Invoke-Native -FilePath $Node -Arguments @($certs, 'create-ca', '--out', $caTemp) -Environment $caEnv -Hide @($CaPassphrase) | Out-Null
    }
    Invoke-Native -FilePath $Node -Arguments @($certs, 'issue-server', '--ca-dir', $caTemp, '--out', $Tls, '--ip', $ShopIp, '--ip', '127.0.0.1') `
      -Environment $caEnv -Hide @($CaPassphrase) | Out-Null
    New-Item -ItemType Directory -Force -Path $CaExportDir | Out-Null
    Copy-Item (Join-Path $caTemp 'coffee-lounge-root.pem') $CaExportDir -Force
    Copy-Item (Join-Path $caTemp 'coffee-lounge-root.key') $CaExportDir -Force
    Copy-Item (Join-Path $caTemp 'coffee-lounge-root.pem') $Tls -Force
    Write-Step "Shop CA key exported to $CaExportDir; it is not kept on this PC."
  } finally {
    Remove-Item -Recurse -Force $caTemp
  }
}
$RootCa = Join-Path $Tls 'coffee-lounge-root.pem'

# ------------------------------------------------------------------ 6. configuration
# The key that seals the mailbox password in the database (P6-4). Kept on reinstall, like
# the other secrets; readable only by the services and administrators (ACL below).
$mailKey = Join-Path $Config 'mail.key'
if (-not (Test-Path $mailKey)) {
  $keyBytes = New-Object byte[] 32
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($keyBytes) } finally { $rng.Dispose() }
  Set-Content -Path $mailKey -Encoding ASCII -Value ([Convert]::ToBase64String($keyBytes))
}
$backupPub = Join-Path $Config 'backup.pub'
$envFile = Join-Path $Config 'server.env'
Set-Content -Path $envFile -Encoding ASCII -Value @"
DATABASE_URL=postgres://cl_service:$servicePassword@127.0.0.1:$PgPort/$Database
HOST=0.0.0.0
CUSTOMER_PORT=8080
STAFF_PORT=8443
STAFF_TLS_CERT=$Tls\server.pem
STAFF_TLS_KEY=$Tls\server.key
WEB_DIST_DIR=$InstallDir\web
DISK_CHECK_PATH=$env:SystemDrive\
BACKUP_DRIVE_PATH=$BackupDrive
BACKUP_PUBLIC_KEY_FILE=$backupPub
PG_BIN_DIR=$PgDir\bin
BACKUP_REPLICATION_URL=postgres://cl_backup:$backupPassword@127.0.0.1:$PgPort/$Database
LIVE_WAL_DIR=$DataDir\live-wal
RESTORE_TEST_DATABASE_URL=postgres://cl_backup:$backupPassword@127.0.0.1:$PgPort/coffee_lounge_restore_test
LOG_DIR=$DataDir\logs
FILES_DIR=$DataDir\files
MAIL_KEY_FILE=$mailKey
UPDATE_DIR=$DataDir\update
LOG_LEVEL=info
"@

# ------------------------------------------------------------------ 6b. backups (BACKUP_RECOVERY.md §1; step 7.1)
# The backup key pair, once: the private key goes to the owner's USB key with the CA key
# and is never kept here; this PC keeps only the public key to encrypt with.
if (-not (Test-Path $backupPub)) {
  if ($CaExportDir) {
    & $Node "--env-file=$envFile" (Join-Path $InstallDir 'app\dist\admin.js') backup-keygen --out $CaExportDir
    if ($LASTEXITCODE -ne 0) { throw 'Could not make the backup key' }
    Write-Step "Backup key made: the private key is on $CaExportDir. Print it and keep both away from this PC."
  } else {
    Write-Step 'No backup key yet: run the installer again with -CaExportDir <owner USB> to make one.'
  }
}
if (Test-Path $backupPub) {
  # WAL archiving every 5 minutes at most, to the backup drive, through wal-archive.js
  # (as the PostgreSQL service account: it needs only the public key).
  # No backslash right before a closing quote: Windows would read it as an escaped quote.
  $driveArg = $BackupDrive.TrimEnd('\') + '\.'
  # Each database cluster archives into its own folder (its system id): a replacement PC's new
  # cluster starts its WAL names again, and must never meet the old PC's files (step 7.3).
  $env:PGPASSWORD = $superPassword
  try { $sysId = (& $Psql -h 127.0.0.1 -p $PgPort -U postgres -d postgres -At -c 'SELECT system_identifier FROM pg_control_system()').Trim() }
  finally { Remove-Item Env:\PGPASSWORD }
  if ($sysId -notmatch '^\d+$') { throw "Could not read the database system id: $sysId" }
  # Not Join-Path: it fails while the backup drive is not plugged in, as on a first install.
  $walDir = [IO.Path]::Combine($BackupDrive, "CoffeeLounge\wal\$sysId")
  $envLines = Get-Content $envFile | Where-Object { $_ -notlike 'BACKUP_WAL_DIR=*' }
  Set-Content -Path $envFile -Encoding ASCII -Value ($envLines + "BACKUP_WAL_DIR=$walDir")
  $walCmd = '"' + $Node + '" "' + (Join-Path $InstallDir 'app\dist\wal-archive.js') + '" --drive "' + $driveArg + '" --dir "' + $walDir + '" --key "' + $backupPub + '" "%p" "%f"'
  $superForArchive = Unprotect-FromFile $superSecret
  Invoke-Sql 'postgres' $superForArchive 'postgres' @"
ALTER SYSTEM SET archive_mode = 'on';
ALTER SYSTEM SET archive_timeout = '300';
ALTER SYSTEM SET max_slot_wal_keep_size = '4GB';
ALTER SYSTEM SET archive_command = '$($walCmd.Replace("'", "''"))';
"@ @($superForArchive)
  Restart-Service -Name $PgService
  for ($i = 0; $i -lt 30; $i++) {
    & (Join-Path $PgDir 'bin\pg_isready.exe') -h 127.0.0.1 -p $PgPort | Out-Null
    if ($LASTEXITCODE -eq 0) { break }
    Start-Sleep -Seconds 2
  }
  Write-Step "WAL archiving to $BackupDrive every 5 minutes at most; nightly backup at 04:35, base backup Mondays at 04:50, test restore on Sundays"
}

# ------------------------------------------------------------------ 6c. restore mode (step 7.3)
if ($RestoreFrom) {
  if (-not $CaExportDir) { throw '-RestoreFrom needs -CaExportDir: the owner USB key with the backup key' }
  $keyFile = Join-Path $CaExportDir 'coffee-lounge-backup-key.txt'
  Write-Step "Restoring the shop's records from $RestoreFrom"
  Invoke-Native -FilePath $Node -Arguments @("--env-file=$envFile", (Join-Path $InstallDir 'app\dist\admin.js'), 'restore-dump', '--key', $keyFile, '--from', $RestoreFrom) `
    -Environment @{ DATABASE_URL = "postgres://cl_migrator:$migratorPassword@127.0.0.1:$PgPort/$Database" } -Hide @($migratorPassword) | Out-Null
}

# ------------------------------------------------------------------ 7. services
$servicesDir = Join-Path $InstallDir 'services'
New-Item -ItemType Directory -Force -Path $servicesDir | Out-Null
foreach ($s in $AppServices) {
  $exe = Join-Path $servicesDir "$s.exe"
  if (Get-Service -Name $s -ErrorAction SilentlyContinue) {
    Invoke-Native -FilePath $exe -Arguments @('uninstall') | Out-Null
  }
  Copy-Item (Join-Path $InstallDir 'winsw\WinSW-x64.exe') $exe -Force
  $xml = Get-Content -Raw (Join-Path $InstallDir "setup\services\$s.xml")
  $xml = $xml.Replace('{{INSTALL_DIR}}', $InstallDir).Replace('{{DATA_DIR}}', $DataDir).Replace('{{PG_SERVICE}}', $PgService)
  Set-Content -Path (Join-Path $servicesDir "$s.xml") -Value $xml -Encoding UTF8
  Invoke-Native -FilePath $exe -Arguments @('install') | Out-Null
  # Each service runs as its own virtual account with no password (WINDOWS_DEPLOYMENT.md §2).
  Invoke-Native -FilePath 'sc.exe' -Arguments @('config', $s, 'obj=', "NT SERVICE\$s") | Out-Null
  Invoke-Native -FilePath 'sc.exe' -Arguments @('failure', $s, 'reset=', '86400', 'actions=', 'restart/5000/restart/10000/restart/30000') | Out-Null
}
$serviceAccounts = $AppServices | ForEach-Object { "NT SERVICE\$_" }
Set-RestrictedAcl -Path $Config -Read $serviceAccounts
# PostgreSQL's own account reads the backup public key for WAL archiving (nothing secret).
if (Test-Path $backupPub) { Set-RestrictedAcl -Path $backupPub -Read ($serviceAccounts + @($PgAccount)) }
Set-RestrictedAcl -Path (Join-Path $DataDir 'logs') -Modify $serviceAccounts
Set-RestrictedAcl -Path (Join-Path $DataDir 'files') -Modify $serviceAccounts
foreach ($s in $AppServices) {
  try {
    Start-Service -Name $s
    Write-Step "Started $s"
  } catch {
    Show-ServiceFailure $s @('coffeelounge', 'WinSW')
    Get-ChildItem (Join-Path $DataDir 'logs') -Filter "$s*" -ErrorAction SilentlyContinue |
      ForEach-Object { Write-Step "--- $($_.Name)"; Write-Step (Get-Content -Raw $_.FullName) }
    throw
  }
}

# ------------------------------------------------------------------ 7b. database watchdog (W-1, P7-5)
$watchdogAction = New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -DataDir "{1}"' -f (Join-Path $InstallDir 'setup\watchdog.ps1'), $DataDir.TrimEnd('\'))
$watchdogTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
$watchdogPrincipal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$watchdogSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName 'Coffee Lounge database watchdog' -Action $watchdogAction -Trigger $watchdogTrigger -Principal $watchdogPrincipal -Settings $watchdogSettings -Force | Out-Null
Write-Step 'Database watchdog: PostgreSQL is started again within a minute if it stops by itself'

# ------------------------------------------------------------------ 7c. the updater
# Administrators-only folder: the server may ask for an update, never change what runs it.
# An update runs this script from the updater itself, whose node.exe is then in use, and whose
# task must not be replaced under it: the next install refreshes those.
$updateDir = Join-Path $DataDir 'update'
$agentDir = Join-Path $DataDir 'update-agent'
New-Item -ItemType Directory -Force -Path $updateDir, $agentDir | Out-Null
Set-RestrictedAcl -Path $updateDir -Modify @('NT SERVICE\coffeelounge-api')
Set-RestrictedAcl -Path $agentDir
$updaterTask = 'Coffee Lounge updater'
$updaterRunning = (Get-ScheduledTask -TaskName $updaterTask -ErrorAction SilentlyContinue | Where-Object { $_.State -eq 'Running' })
foreach ($f in @('setup\update-agent.mjs', 'setup\update-public.pem', 'runtime\node.exe')) {
  if ($updaterRunning -and $f -like '*node.exe') { continue }
  Copy-Item (Join-Path $InstallDir $f) $agentDir -Force
}
$manifestUrl = 'https://github.com/AliWaleedAwan/coffee-lounge-releases/releases/latest/download/latest.json'
$existingConfig = Join-Path $agentDir 'config.json'
if (Test-Path $existingConfig) { $manifestUrl = (Get-Content -Raw $existingConfig | ConvertFrom-Json).manifestUrl }
Write-Utf8NoBom $existingConfig (@{
    manifestUrl = $manifestUrl
    publicKeyFile = (Join-Path $agentDir 'update-public.pem')
    installDir = $InstallDir
    updateDir = $updateDir
    agentDir = $agentDir
    logDir = (Join-Path $DataDir 'logs')
    backupDrive = $BackupDrive
  } | ConvertTo-Json)
if (-not $updaterRunning) {
  $updaterAction = New-ScheduledTaskAction -Execute (Join-Path $agentDir 'node.exe') -Argument ('"{0}" "{1}"' -f (Join-Path $agentDir 'update-agent.mjs'), $existingConfig)
  $updaterTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
  $updaterSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 2) -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName $updaterTask -Action $updaterAction -Trigger $updaterTrigger -Principal (New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest) -Settings $updaterSettings -Force | Out-Null
}
Write-Step 'Updater: checks for a new version every 6 hours; installs only when the owner asks'

# ------------------------------------------------------------------ 8. firewall (H-3)
Get-NetFirewallRule -DisplayName 'CoffeeLounge *' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName 'CoffeeLounge Customer' -Direction Inbound -Protocol TCP -LocalPort 8080 -RemoteAddress LocalSubnet -Profile Private -Action Allow | Out-Null
New-NetFirewallRule -DisplayName 'CoffeeLounge Staff' -Direction Inbound -Protocol TCP -LocalPort 8443 -RemoteAddress LocalSubnet -Profile Private -Action Allow | Out-Null
Write-Step 'Firewall: 8080 and 8443 open to the local subnet on private networks only'

# ------------------------------------------------------------------ 9. host settings (H-4, H-5, H-12, H-13, H-15)
if (-not $SkipHostSettings) {
  Invoke-Native -FilePath 'powercfg.exe' -Arguments @('/hibernate', 'off') | Out-Null
  Invoke-Native -FilePath 'powercfg.exe' -Arguments @('/change', 'standby-timeout-ac', '0') | Out-Null
  Set-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Power' -Name HiberbootEnabled -Value 0
  Set-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server' -Name fDenyTSConnections -Value 1
  Set-TimeZone -Id 'Pakistan Standard Time'
  try { Add-MpPreference -ExclusionPath $PgData } catch { Write-Step "Defender exclusion not set: $($_.Exception.Message)" }
  Write-Step 'Host settings applied: no sleep or hibernation, Fast Startup off, Remote Desktop off, Asia/Karachi'
}

# ------------------------------------------------------------------ 10. counter app settings (WINDOWS_DEPLOYMENT.md §10)
Copy-Item $RootCa (Join-Path $desktopDir 'coffee-lounge-root.pem') -Force
Write-Utf8NoBom (Join-Path $desktopDir 'desktop.json') (@{ serverUrl = 'https://127.0.0.1:8443'; caCertFile = 'coffee-lounge-root.pem'; fullscreen = $true; databaseService = $PgService; maintenanceFlag = $MaintenanceFlag } | ConvertTo-Json)
Set-RestrictedAcl -Path $desktopDir -Read @('*S-1-5-32-545') # Users: read only

$counterExe = Join-Path $InstallDir 'desktop\CoffeeLounge.exe'
$shortcut = Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\Coffee Lounge.lnk'
$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut($shortcut)
$link.TargetPath = $counterExe
$link.WorkingDirectory = Join-Path $InstallDir 'desktop'
$link.Description = 'Coffee Lounge counter app'
$link.Save()
# The same icon on the desktop of every Windows user of this PC.
$link = $shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('CommonDesktopDirectory')) 'Coffee Lounge.lnk'))
$link.TargetPath = $counterExe
$link.WorkingDirectory = Join-Path $InstallDir 'desktop'
$link.Description = 'Coffee Lounge counter app'
$link.Save()

# H-11: the counter app opens (full screen, per desktop.json) when the Counter user logs in.
$taskName = 'Coffee Lounge counter app'
if (Get-LocalUser -Name $CounterUser -ErrorAction SilentlyContinue) {
  $account = "$env:COMPUTERNAME\$CounterUser"
  $task = New-ScheduledTask `
    -Action (New-ScheduledTaskAction -Execute $counterExe -WorkingDirectory (Join-Path $InstallDir 'desktop')) `
    -Trigger (New-ScheduledTaskTrigger -AtLogOn -User $account) `
    -Principal (New-ScheduledTaskPrincipal -UserId $account -LogonType Interactive -RunLevel Limited) `
    -Settings (New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew)
  Register-ScheduledTask -TaskName $taskName -InputObject $task -Force | Out-Null
  Write-Step "Counter app starts at the login of $account"
  # Step 8.5: the app's start-up screen starts a stopped service as this account, which is
  # not an administrator. It gets that right on these three services and nothing else.
  foreach ($s in (@($PgService) + $AppServices)) { Grant-ServiceStart $s $account }
  Write-Step "$account may start the database, server and background jobs services"
} else {
  Write-Step "Windows user '$CounterUser' not found: create it (H-9), then run the installer again so the counter app starts at its login."
}

# Add/Remove Programs
$uninstallKey = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\CoffeeLounge'
New-Item -Path $uninstallKey -Force | Out-Null
$versionLine = (Get-Content (Join-Path $InstallDir 'VERSION.txt') -TotalCount 1)
foreach ($pair in @(
    @('DisplayName', 'Coffee Lounge'),
    @('DisplayVersion', ($versionLine -replace '^Coffee Lounge (\S+).*$', '$1')),
    @('Publisher', 'Coffee Lounge'),
    @('InstallLocation', $InstallDir),
    @('DisplayIcon', $counterExe),
    @('UninstallString', ("powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"{0}`"" -f (Join-Path $InstallDir 'setup\uninstall.ps1')))
  )) { Set-ItemProperty -Path $uninstallKey -Name $pair[0] -Value $pair[1] }
Set-ItemProperty -Path $uninstallKey -Name NoModify -Value 1 -Type DWord
Set-ItemProperty -Path $uninstallKey -Name NoRepair -Value 1 -Type DWord

# ------------------------------------------------------------------ 11. health check
$waitReady = Join-Path $InstallDir 'setup\wait-ready.mjs'
Invoke-Native -FilePath $Node -Arguments @($waitReady, 'https://127.0.0.1:8443/health/ready', $RootCa, '180') | Out-Null
Invoke-Native -FilePath $Node -Arguments @($waitReady, 'http://127.0.0.1:8080/health/ready', '-', '60') | Out-Null

if ($firstInstall -and $Wizard -and $env:CL_OWNER_PASSWORD) {
  # The recovery code goes on the USB key, never into the install log.
  Write-Step 'Creating the owner account'
  $created = & $Node "--env-file=$envFile" (Join-Path $InstallDir 'app\dist\admin.js') create-owner --username owner --name Owner
  if ($LASTEXITCODE -ne 0) { throw 'Creating the owner failed.' }
  $codeLine = @($created) | Where-Object { $_ -match 'RECOVERY CODE' } | Select-Object -First 1
  if (-not $codeLine) { throw 'The owner was created, but no recovery code was shown.' }
  Set-Content -Path (Join-Path $CaExportDir 'coffee-lounge-owner-recovery-code.txt') -Value $codeLine -Encoding UTF8
  Write-Step 'The recovery code is on the USB key'
} elseif ($firstInstall -and -not $Unattended) {
  Write-Step 'Create the owner account (password typed twice, recovery code printed once):'
  & $Node "--env-file=$envFile" (Join-Path $InstallDir 'app\dist\admin.js') create-owner --username owner --name Owner
  if ($LASTEXITCODE -ne 0) { throw 'Creating the owner failed.' }
}
$script:UpgradeArmed = $false
Remove-Item -Force $MaintenanceFlag -ErrorAction SilentlyContinue
if ($upgrading) { Write-Step 'Upgrade finished: health checks green.' }
Write-Step 'Install finished.'
