# Coffee Lounge installer skeleton (WINDOWS_DEPLOYMENT.md §1, §2, §3, §6). Run as an
# Administrator from the bundle's setup folder. Safe to run again: an existing database,
# secrets and certificates are kept (that is also the upgrade path).
#
#   powershell -ExecutionPolicy Bypass -File setup\install.ps1 -CaExportDir E:\CoffeeLounge-Keys
#
# First install needs -CaExportDir: the owner's separate USB key. The shop CA's private
# key is written there and removed from this PC. Not automated: static IP and network
# profile (H-1, H-2), test print and setup sheet (Phase 3/7).
param(
  [string]$Source = (Split-Path -Parent $PSScriptRoot),
  [string]$InstallDir = 'C:\Program Files\CoffeeLounge',
  [string]$PgDir = 'C:\Program Files\PostgreSQL\17',
  [string]$DataDir = 'C:\ProgramData\CoffeeLounge',
  [string]$ShopIp = '192.168.100.250',
  [string]$CaExportDir = '',
  # Unattended installs only (tests); otherwise typed without echo.
  [string]$CaPassphrase = '',
  [int]$PgPort = 5432,
  # Windows account the counter app starts for at login (H-9, H-11).
  [string]$CounterUser = 'Counter',
  # Leave power, time zone, Defender and Remote Desktop alone (test machines, CI).
  [switch]$SkipHostSettings,
  [switch]$Unattended
)
. (Join-Path $PSScriptRoot 'lib.ps1')

$PgService = 'postgresql-x64-17'
$AppServices = @('coffeelounge-api', 'coffeelounge-worker')
$Database = 'coffee_lounge'
$Config = Join-Path $DataDir 'config'
$Tls = Join-Path $Config 'tls'
$PgData = Join-Path $DataDir 'pgdata'
$Node = Join-Path $InstallDir 'runtime\node.exe'
$Psql = Join-Path $PgDir 'bin\psql.exe'

if (-not (Test-Admin)) { throw 'Run the installer as an Administrator.' }
# Unattended runs through CoffeeLounge-Setup.exe pass the CA passphrase in the environment.
if (-not $CaPassphrase -and $env:CL_CA_PASSPHRASE) { $CaPassphrase = $env:CL_CA_PASSPHRASE }
foreach ($d in @($DataDir, $Config, (Join-Path $DataDir 'logs'), (Join-Path $DataDir 'files'), (Join-Path $DataDir 'desktop'))) {
  New-Item -ItemType Directory -Force -Path $d | Out-Null
}
$script:LogFile = Join-Path $DataDir ("logs\install-{0}.log" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
Write-Step "Coffee Lounge install from $Source"
Write-Step (Get-Content -Raw (Join-Path $Source 'VERSION.txt'))

# ------------------------------------------------------------------ 1. checks
$firstInstall = -not (Test-Path (Join-Path $Config 'server.env'))
$needCertificates = -not (Test-Path (Join-Path $Tls 'server.pem'))
if (-not [Environment]::Is64BitOperatingSystem) { throw 'A 64-bit Windows is required.' }
$freeGb = [math]::Floor((Get-PSDrive -Name ($env:SystemDrive.TrimEnd(':'))).Free / 1GB)
if ($freeGb -lt 20) { throw "At least 20 GB free disk space is needed (found $freeGb GB)." }
if ($needCertificates -and -not $CaExportDir) {
  throw 'First install: pass -CaExportDir with the owner''s USB key folder for the shop CA key.'
}
$ourServicesExist = [bool](Get-Service -Name $AppServices -ErrorAction SilentlyContinue)
if (-not $ourServicesExist) {
  foreach ($port in @(8080, 8443)) { if (-not (Test-PortFree $port)) { throw "Port $port is in use by another program." } }
}
$pgServiceObj = Get-Service -Name $PgService -ErrorAction SilentlyContinue
if ($pgServiceObj) {
  $imagePath = (Get-ItemProperty "HKLM:\SYSTEM\CurrentControlSet\Services\$PgService").ImagePath
  if ($imagePath -notlike "*$PgData*") { throw "A different $PgService service exists ($imagePath). Remove it first." }
} elseif (-not (Test-PortFree $PgPort)) {
  throw "Port $PgPort is in use (another PostgreSQL?)."
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
if ($pgServiceObj -and $pgServiceObj.Status -eq 'Running') { Stop-Service -Name $PgService -Force }
Write-Step "Copying PostgreSQL to $PgDir"
Copy-Tree (Join-Path $Source 'pgsql') $PgDir

$superSecret = Join-Path $Config 'postgres.secret'
if (-not (Test-Path (Join-Path $PgData 'PG_VERSION'))) {
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
  Add-Content -Path (Join-Path $PgData 'postgresql.conf') -Value @"

# --- Coffee Lounge ---
listen_addresses = 'localhost'
port = $PgPort
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
"@
  Set-Content -Path (Join-Path $PgData 'pg_hba.conf') -Encoding ASCII -Value @"
# Coffee Lounge: password logins from this PC only.
host all all 127.0.0.1/32 scram-sha-256
host all all ::1/128      scram-sha-256
"@
}
Set-RestrictedAcl -Path $PgData -Modify @('NT AUTHORITY\NETWORK SERVICE')
# initdb may leave explicit permissions on files inside: grant the service account
# down the whole tree, as the EDB installer does.
Invoke-Native -FilePath 'icacls.exe' -Arguments @($PgData, '/grant', 'NT AUTHORITY\NETWORK SERVICE:(OI)(CI)M', '/T', '/Q') | Out-Null
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
$superPassword = Unprotect-FromFile $superSecret
for ($i = 0; $i -lt 30; $i++) {
  & (Join-Path $PgDir 'bin\pg_isready.exe') -h 127.0.0.1 -p $PgPort | Out-Null
  if ($LASTEXITCODE -eq 0) { break }
  Start-Sleep -Seconds 2
}

function Invoke-Sql([string]$User, [string]$Password, [string]$Db, [string]$Sql, [string[]]$Hide = @()) {
  Invoke-Native -FilePath $Psql -Arguments @('-h', '127.0.0.1', '-p', "$PgPort", '-U', $User, '-d', $Db, '-v', 'ON_ERROR_STOP=1', '-q', '-f', '-') `
    -InputText $Sql -Hide ($Hide + @($Password)) -Environment @{ PGPASSWORD = $Password } | Out-Null
}

# ------------------------------------------------------------------ 4. logins and database
$migratorSecret = Join-Path $Config 'migrator.secret'
$serviceSecret = Join-Path $Config 'service.secret'
if (-not (Test-Path $migratorSecret)) {
  $migratorPassword = New-Secret
  $servicePassword = New-Secret
  Write-Step 'Creating the database and its logins'
  Invoke-Sql 'postgres' $superPassword 'postgres' @"
CREATE ROLE cl_migrator LOGIN CREATEROLE PASSWORD '$migratorPassword';
CREATE ROLE cl_service LOGIN PASSWORD '$servicePassword';
CREATE DATABASE $Database OWNER cl_migrator ENCODING 'UTF8' TEMPLATE template0;
REVOKE CONNECT ON DATABASE $Database FROM PUBLIC;
GRANT CONNECT ON DATABASE $Database TO cl_service;
"@ @($migratorPassword, $servicePassword)
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
    Invoke-Native -FilePath $Node -Arguments @($certs, 'create-ca', '--out', $caTemp) -Environment $caEnv -Hide @($CaPassphrase) | Out-Null
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
BACKUP_DRIVE_PATH=B:\
LOG_LEVEL=info
"@

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
  $xml = $xml.Replace('{{INSTALL_DIR}}', $InstallDir).Replace('{{DATA_DIR}}', $DataDir)
  Set-Content -Path (Join-Path $servicesDir "$s.xml") -Value $xml -Encoding UTF8
  Invoke-Native -FilePath $exe -Arguments @('install') | Out-Null
  # Each service runs as its own virtual account with no password (WINDOWS_DEPLOYMENT.md §2).
  Invoke-Native -FilePath 'sc.exe' -Arguments @('config', $s, 'obj=', "NT SERVICE\$s") | Out-Null
  Invoke-Native -FilePath 'sc.exe' -Arguments @('failure', $s, 'reset=', '86400', 'actions=', 'restart/5000/restart/10000/restart/30000') | Out-Null
}
$serviceAccounts = $AppServices | ForEach-Object { "NT SERVICE\$_" }
Set-RestrictedAcl -Path $Config -Read $serviceAccounts
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
$desktopDir = Join-Path $DataDir 'desktop'
Copy-Item $RootCa (Join-Path $desktopDir 'coffee-lounge-root.pem') -Force
Set-Content -Path (Join-Path $desktopDir 'desktop.json') -Encoding UTF8 -Value '{ "serverUrl": "https://127.0.0.1:8443", "caCertFile": "coffee-lounge-root.pem", "fullscreen": true }'
Set-RestrictedAcl -Path $desktopDir -Read @('*S-1-5-32-545') # Users: read only

$counterExe = Join-Path $InstallDir 'desktop\CoffeeLounge.exe'
$shortcut = Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\Coffee Lounge.lnk'
$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut($shortcut)
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

if ($firstInstall -and -not $Unattended) {
  Write-Step 'Create the owner account (password typed twice, recovery code printed once):'
  & $Node "--env-file=$envFile" (Join-Path $InstallDir 'app\dist\admin.js') create-owner --username owner --name Owner
  if ($LASTEXITCODE -ne 0) { throw 'Creating the owner failed.' }
}
Write-Step 'Install finished.'
