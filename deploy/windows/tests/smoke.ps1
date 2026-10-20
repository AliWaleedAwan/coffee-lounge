# AT-47 on Windows (TEST_PLAN.md): the installed services start and behave as designed
# on a clean machine, plus recovery from a crashed API and a crashed database
# (WINDOWS_DEPLOYMENT.md §2, AT-17). Run as Administrator after install.ps1.
param(
  [string]$InstallDir = 'C:\Program Files\CoffeeLounge',
  [string]$PgDir = 'C:\Program Files\PostgreSQL\17',
  [string]$DataDir = 'C:\ProgramData\CoffeeLounge',
  [string]$CaExportDir = '',
  [int]$PgPort = 5432
)
. (Join-Path $PSScriptRoot '..\lib.ps1')

$Node = Join-Path $InstallDir 'runtime\node.exe'
$Tls = Join-Path $DataDir 'config\tls'
$RootCa = Join-Path $Tls 'coffee-lounge-root.pem'
$HttpGet = Join-Path $PSScriptRoot 'http-get.mjs'
$WaitReady = Join-Path $InstallDir 'setup\wait-ready.mjs'
$script:Failures = New-Object System.Collections.Generic.List[string]

function Check([string]$Name, [scriptblock]$Test) {
  try {
    $result = & $Test
    if ($result -is [bool] -and -not $result) { throw 'condition was false' }
    Write-Step "PASS  $Name"
  } catch {
    Write-Step "FAIL  $Name : $($_.Exception.Message)"
    $script:Failures.Add($Name)
  }
}

function Get-Http([string]$Url, [string]$Ca = '-') {
  $json = & $Node $HttpGet $Url $Ca
  return $json | ConvertFrom-Json
}

function Wait-Ready([int]$Seconds = 120) {
  & $Node $WaitReady 'https://127.0.0.1:8443/health/ready' $RootCa "$Seconds" | Out-Null
  return ($LASTEXITCODE -eq 0)
}

function Invoke-ServiceSql([string]$Sql) {
  $envLine = Get-Content (Join-Path $DataDir 'config\server.env') | Where-Object { $_ -like 'DATABASE_URL=*' }
  $url = $envLine.Substring('DATABASE_URL='.Length)
  $password = ([Uri]$url).UserInfo.Split(':')[1]
  $env:PGPASSWORD = $password
  # Expected SQL errors arrive on stderr; 5.1 would turn them into exceptions under 'Stop'.
  $savedPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $out = & (Join-Path $PgDir 'bin\psql.exe') -h 127.0.0.1 -p $PgPort -U cl_service -d coffee_lounge -At -c $Sql 2>&1
    return [pscustomobject]@{ Code = $LASTEXITCODE; Output = (($out | ForEach-Object { "$_" }) -join "`n") }
  } finally {
    $ErrorActionPreference = $savedPreference
    Remove-Item Env:\PGPASSWORD
  }
}

function Get-ServiceNodePid([string]$Name) {
  $wrapper = (Get-CimInstance Win32_Service -Filter "Name='$Name'").ProcessId
  $child = Get-CimInstance Win32_Process -Filter "ParentProcessId=$wrapper AND Name='node.exe'"
  if (-not $child) { return 0 }
  return [int]$child.ProcessId
}

# ------------------------------------------------------------------ service configuration
foreach ($s in @('coffeelounge-api', 'coffeelounge-worker')) {
  Check "$s is running, automatic (delayed), as its own virtual account" {
    $svc = Get-CimInstance Win32_Service -Filter "Name='$s'"
    $delayed = (Get-ItemProperty "HKLM:\SYSTEM\CurrentControlSet\Services\$s").DelayedAutostart
    if ($svc.State -ne 'Running') { throw "state $($svc.State)" }
    if ($svc.StartMode -ne 'Auto') { throw "start mode $($svc.StartMode)" }
    if ($delayed -ne 1) { throw 'not delayed' }
    if ($svc.StartName -ne "NT SERVICE\$s") { throw "account $($svc.StartName)" }
    $true
  }
  Check "$s depends on PostgreSQL and restarts after 5 s, 10 s, 30 s" {
    $deps = (Get-Service $s).ServicesDependedOn.Name
    if ($deps -notcontains 'postgresql-x64-17') { throw "depends on: $deps" }
    $failure = (& sc.exe qfailure $s) -join "`n"
    foreach ($ms in @('5000', '10000', '30000')) {
      if ($failure -notmatch "RESTART -- Delay = $ms") { throw "recovery actions: $failure" }
    }
    $true
  }
}
Check 'PostgreSQL runs automatically as NetworkService and listens on this PC only' {
  $svc = Get-CimInstance Win32_Service -Filter "Name='postgresql-x64-17'"
  if ($svc.State -ne 'Running' -or $svc.StartMode -ne 'Auto') { throw "$($svc.State) $($svc.StartMode)" }
  if ($svc.StartName -notmatch 'NetworkService') { throw "account $($svc.StartName)" }
  $listen = Get-NetTCPConnection -State Listen -LocalPort $PgPort
  $outside = $listen | Where-Object { $_.LocalAddress -notin @('127.0.0.1', '::1') }
  if ($outside) { throw "listening on $($outside.LocalAddress -join ', ')" }
  $true
}

# ------------------------------------------------------------------ listeners and TLS
Check 'staff listener is ready over HTTPS with the shop certificate' { Wait-Ready 60 }
Check 'customer listener is ready over HTTP' { (Get-Http 'http://127.0.0.1:8080/health/ready').status -eq 200 }
Check 'the staff certificate is trusted only through the shop root' {
  $r = Get-Http 'https://127.0.0.1:8443/health/ready'
  if ($r.status -ne 0) { throw "connected without the shop root: $($r.status)" }
  $true
}
Check 'the staff web app is served with its content security policy' {
  $r = Get-Http 'https://127.0.0.1:8443/login' $RootCa
  if ($r.status -ne 200) { throw "status $($r.status)" }
  if ($r.headers.'content-security-policy' -notmatch "default-src 'self'") { throw 'no CSP' }
  $true
}

# ------------------------------------------------------------------ data and secrets
Check 'the worker heartbeat is fresh' {
  $r = Invoke-ServiceSql "SELECT now() - beat_at < interval '60 seconds' FROM cl.worker_heartbeats WHERE worker_name = 'worker'"
  if ($r.Code -ne 0 -or $r.Output -ne 't') { throw $r.Output }
  $true
}
Check 'the services log in without owner or superuser powers' {
  $who = Invoke-ServiceSql 'SELECT current_user || ''/'' || rolsuper || ''/'' || rolcreaterole FROM pg_roles WHERE rolname = current_user'
  if ($who.Output -ne 'cl_service/false/false') { throw $who.Output }
  $ddl = Invoke-ServiceSql 'CREATE TABLE cl.not_allowed (id int)'
  if ($ddl.Code -eq 0) { throw 'cl_service could change the schema' }
  $true
}
Check 'secrets are not readable by ordinary users' {
  $config = Join-Path $DataDir 'config'
  foreach ($item in @($config, (Join-Path $config 'server.env'), (Join-Path $Tls 'server.key'))) {
    $ids = (Get-Acl $item).Access | ForEach-Object { $_.IdentityReference.Value }
    $open = $ids | Where-Object { $_ -match 'Users|Everyone|Authenticated' }
    if ($open) { throw "$item readable by $($open -join ', ')" }
  }
  $true
}
Check 'the shop CA key is not on this PC (exported for the owner)' {
  $left = Get-ChildItem -Recurse -ErrorAction SilentlyContinue -Path $DataDir, $InstallDir -Filter 'coffee-lounge-root.key'
  if ($left) { throw "found $($left.FullName -join ', ')" }
  if ($CaExportDir -and -not (Test-Path (Join-Path $CaExportDir 'coffee-lounge-root.key'))) { throw 'not exported' }
  $true
}
Check 'the counter app settings point at the server through the loopback address' {
  $settings = Get-Content -Raw (Join-Path $DataDir 'desktop\desktop.json') | ConvertFrom-Json
  ($settings.serverUrl -eq 'https://127.0.0.1:8443') -and (Test-Path (Join-Path $DataDir 'desktop\coffee-lounge-root.pem'))
}

# ------------------------------------------------------------------ recovery
Check 'a crashed API is restarted by Windows and serves again' {
  $before = Get-ServiceNodePid 'coffeelounge-api'
  if (-not $before) { throw 'no API process found' }
  Stop-Process -Id $before -Force
  $deadline = (Get-Date).AddSeconds(90)
  do {
    Start-Sleep -Seconds 3
    $after = Get-ServiceNodePid 'coffeelounge-api'
  } while ((-not $after -or $after -eq $before) -and (Get-Date) -lt $deadline)
  if (-not $after -or $after -eq $before) { throw 'not restarted' }
  Wait-Ready 90
}
Check 'a crashed database process is recovered by PostgreSQL and the API carries on (AT-17)' {
  # The postmaster is the child of the pg_ctl service process; kill one of its backends,
  # as a crash would. PostgreSQL then resets every connection and recovers on its own.
  $wrapper = (Get-CimInstance Win32_Service -Filter "Name='postgresql-x64-17'").ProcessId
  $postmaster = Get-CimInstance Win32_Process -Filter "ParentProcessId=$wrapper AND Name='postgres.exe'"
  $backend = Get-CimInstance Win32_Process -Filter "ParentProcessId=$($postmaster.ProcessId) AND Name='postgres.exe'" | Select-Object -First 1
  if (-not $backend) { throw 'no backend process found' }
  Stop-Process -Id $backend.ProcessId -Force
  Start-Sleep -Seconds 5
  if ((Get-Service 'postgresql-x64-17').Status -ne 'Running') { throw 'PostgreSQL service stopped' }
  if (-not (Wait-Ready 120)) { throw 'API not ready again' }
  $log = Get-ChildItem (Join-Path $DataDir 'pgdata\log') | Sort-Object LastWriteTime | Select-Object -Last 1
  if ((Get-Content -Raw $log.FullName) -notmatch 'terminated by exception|reinitializing') { throw 'no crash recovery in the PostgreSQL log' }
  ((Get-Service 'coffeelounge-api').Status -eq 'Running') -and ((Get-Service 'coffeelounge-worker').Status -eq 'Running')
}

if ($script:Failures.Count -gt 0) {
  Write-Step "$($script:Failures.Count) check(s) failed: $($script:Failures -join '; ')"
  exit 1
}
Write-Step 'All Windows checks passed.'
