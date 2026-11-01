# AT-47 on Windows (TEST_PLAN.md): the installed services start and behave as designed
# on a clean machine, plus recovery from a crashed API and a crashed database
# (WINDOWS_DEPLOYMENT.md §2, AT-17). Run as Administrator after install.ps1.
param(
  [string]$InstallDir = 'C:\Program Files\CoffeeLounge',
  [string]$PgDir = 'C:\Program Files\PostgreSQL\17',
  [string]$DataDir = 'C:\ProgramData\CoffeeLounge',
  [string]$CaExportDir = '',
  [int]$PgPort = 5432,
  [string]$CounterUser = 'Counter',
  [string]$BackupDrive = 'B:\'
)
. (Join-Path $PSScriptRoot '..\lib.ps1')

$Node = Join-Path $InstallDir 'runtime\node.exe'
$Tls = Join-Path $DataDir 'config\tls'
$RootCa = Join-Path $Tls 'coffee-lounge-root.pem'
$HttpGet = Join-Path $PSScriptRoot 'http-get.mjs'
$WaitReady = Join-Path $InstallDir 'setup\wait-ready.mjs'
$script:Failures = New-Object System.Collections.Generic.List[string]
$CounterExe = Join-Path $InstallDir 'desktop\CoffeeLounge.exe'

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
# PRINTING_HARDWARE.md §2 path F: the worker service hands raw ESC/POS bytes to a Windows
# print queue in RAW mode. A "Generic / Text Only" queue writing to a file stands in for
# the shop's USB printer (the real printer is AT-85, on site).
Check 'the worker service prints RAW through a Windows print queue (spooler path)' {
  $queue = 'CL Test Printer'
  $dir = 'C:\cl-print'
  $out = Join-Path $dir 'out.prn'
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  Remove-Item $out -ErrorAction SilentlyContinue
  Set-Service -Name Spooler -StartupType Automatic
  Start-Service -Name Spooler
  if (-not (Get-PrinterDriver -Name 'Generic / Text Only' -ErrorAction SilentlyContinue)) { Add-PrinterDriver -Name 'Generic / Text Only' }
  if (-not (Get-PrinterPort -Name $out -ErrorAction SilentlyContinue)) { Add-PrinterPort -Name $out }
  if (-not (Get-Printer -Name $queue -ErrorAction SilentlyContinue)) { Add-Printer -Name $queue -DriverName 'Generic / Text Only' -PortName $out }
  $envFile = Join-Path $DataDir 'config\server.env'
  $admin = Join-Path $InstallDir 'app\dist\admin.js'
  & $Node "--env-file=$envFile" $admin printer-add --name $queue --connection spooler --address $queue | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'admin printer-add failed' }
  & $Node "--env-file=$envFile" $admin test-print --name $queue | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'admin test-print failed' }
  # The file may first hold another job or a part of this one (seen after a reinstall), so
  # wait for this job to be sent and its text to arrive, not just for any bytes.
  $deadline = (Get-Date).AddSeconds(120)
  $text = ''
  do {
    Start-Sleep -Seconds 2
    $last = Invoke-ServiceSql "SELECT status || ' ' || coalesce(last_error, '') FROM cl.print_jobs ORDER BY print_jobs.id DESC LIMIT 1"
    if (Test-Path $out) {
      try { $text = [System.Text.Encoding]::ASCII.GetString([System.IO.File]::ReadAllBytes($out)) } catch { $text = '' } # the spooler still has it open
    }
  } while ((Get-Date) -lt $deadline -and -not ($last.Output.Trim() -eq 'sent' -and $text -match 'TEST PRINT'))
  if (-not (Test-Path $out)) { throw "nothing reached the queue; last job: $($last.Output)" }
  if ($text -notmatch 'TEST PRINT') { throw "the queue received other bytes; last job: $($last.Output)" }
  if ($last.Output.Trim() -ne 'sent') { throw "job status: $($last.Output)" }
  Write-Step ('  print: {0} bytes through "{1}"' -f (Get-Item $out).Length, $queue)
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
  foreach ($item in @($config, (Join-Path $config 'server.env'), (Join-Path $config 'mail.key'), (Join-Path $Tls 'server.key'))) {
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

# ------------------------------------------------------------------ counter app (step 2.9b)
Check "the counter app is installed and opens at the $CounterUser login in full screen" {
  if (-not (Test-Path $CounterExe)) { throw 'CoffeeLounge.exe is missing' }
  $task = Get-ScheduledTask -TaskName 'Coffee Lounge counter app' -ErrorAction Stop
  $trigger = @($task.Triggers)[0]
  if ($trigger.CimClass.CimClassName -ne 'MSFT_TaskLogonTrigger') { throw "trigger is $($trigger.CimClass.CimClassName)" }
  if ($trigger.UserId -notmatch "\\$CounterUser$") { throw "starts for $($trigger.UserId)" }
  if ($task.Principal.RunLevel -ne 'Limited') { throw "runs with $($task.Principal.RunLevel) rights" }
  if (@($task.Actions)[0].Execute -ne $CounterExe) { throw "starts $(@($task.Actions)[0].Execute)" }
  $settings = Get-Content -Raw (Join-Path $DataDir 'desktop\desktop.json') | ConvertFrom-Json
  if (-not $settings.fullscreen) { throw 'not full screen' }
  if (-not (Test-Path (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\Coffee Lounge.lnk'))) { throw 'no Start menu shortcut' }
  $entry = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\CoffeeLounge' -ErrorAction Stop
  ($entry.DisplayName -eq 'Coffee Lounge') -and ($entry.UninstallString -match 'uninstall\.ps1')
}
Check 'the installed counter app cannot be used as a Node.js shell (RunAsNode fuse)' {
  $marker = Join-Path $env:TEMP 'cl-runasnode.txt'
  Remove-Item $marker -ErrorAction SilentlyContinue
  $env:ELECTRON_RUN_AS_NODE = '1'
  try {
    Start-Process -FilePath $CounterExe -ArgumentList @('-e', "require('fs').writeFileSync(process.env.TEMP+'/cl-runasnode.txt','node')") | Out-Null
  } finally { Remove-Item Env:\ELECTRON_RUN_AS_NODE }
  Start-Sleep -Seconds 10
  Get-Process -Name 'CoffeeLounge' -ErrorAction SilentlyContinue | Stop-Process -Force
  if (Test-Path $marker) { throw 'ELECTRON_RUN_AS_NODE ran Node.js code' }
  $true
}
Check 'the installed counter app opens the staff app over the pinned HTTPS connection' {
  $log = Join-Path $env:APPDATA 'Coffee Lounge\desktop.log'
  Remove-Item $log -ErrorAction SilentlyContinue
  Start-Process -FilePath $CounterExe | Out-Null
  try {
    $deadline = (Get-Date).AddSeconds(90)
    $text = ''
    do {
      Start-Sleep -Seconds 2
      if (Test-Path $log) { $text = Get-Content -Raw $log }
    } while ($text -notmatch '"page loaded","page":"https://127\.0\.0\.1:8443/' -and (Get-Date) -lt $deadline)
    ($text -split "`n") | Select-Object -Last 6 | ForEach-Object { if ($_) { Write-Step "  app log: $_" } }
    if ($text -match 'certificate refused') { throw 'the app refused the shop certificate' }
    if ($text -notmatch '"page loaded","page":"https://127\.0\.0\.1:8443/') { throw 'the app did not open the staff app' }
    $true
  } finally {
    Get-Process -Name 'CoffeeLounge' -ErrorAction SilentlyContinue | Stop-Process -Force
  }
}

# ------------------------------------------------------------------ start-up screen (step 8.5)
# The Counter user's rights and the app run as that user, not as this administrator.
$counterPassword = 'Ci1!' + [guid]::NewGuid().ToString('N')
Set-LocalUser -Name $CounterUser -Password (ConvertTo-SecureString $counterPassword -AsPlainText -Force)
$counterCredential = New-Object Management.Automation.PSCredential("$env:COMPUTERNAME\$CounterUser", (ConvertTo-SecureString $counterPassword -AsPlainText -Force))
function Invoke-AsCounter([string[]]$ScArguments) {
  $p = Start-Process -FilePath 'sc.exe' -ArgumentList $ScArguments -Credential $counterCredential -WorkingDirectory $env:SystemRoot -WindowStyle Hidden -Wait -PassThru
  return $p.ExitCode
}
$startupServices = @('postgresql-x64-17', 'coffeelounge-api', 'coffeelounge-worker')
Check "$CounterUser may start these services, but not stop or reconfigure them, nor start another" {
  foreach ($s in $startupServices) {
    $code = Invoke-AsCounter @('stop', $s)
    if ($code -ne 5) { throw "stop $s answered $code" }
    $code = Invoke-AsCounter @('config', $s, 'start=', 'disabled')
    if ($code -ne 5) { throw "config $s answered $code" }
    $code = Invoke-AsCounter @('start', $s)
    if ($code -ne 1056) { throw "start $s answered $code" } # already running: the right was checked
  }
  $code = Invoke-AsCounter @('start', 'Spooler')
  if ($code -ne 5 -and $code -ne 1056) { throw "start Spooler answered $code" }
  $sddl = (& sc.exe sdshow 'Spooler') -join ''
  $sid = (New-Object Security.Principal.NTAccount("$env:COMPUTERNAME\$CounterUser")).Translate([Security.Principal.SecurityIdentifier]).Value
  if ($sddl -match [regex]::Escape($sid)) { throw 'the right reached the print service' }
  $true
}
$counterLog = "C:\Users\$CounterUser\AppData\Roaming\Coffee Lounge\desktop.log"
foreach ($stopped in @('coffeelounge-worker', 'coffeelounge-api', 'postgresql-x64-17')) {
  Check "$stopped stopped: the app, run as $CounterUser, starts it and opens" {
    Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', 'exit' -Credential $counterCredential -LoadUserProfile -WindowStyle Hidden -Wait | Out-Null
    if (Test-Path $counterLog) { Remove-Item $counterLog -Force }
    # The watchdog would start the database itself within a minute: this has to be the app.
    $watchdog = 'Coffee Lounge database watchdog'
    Disable-ScheduledTask -TaskName $watchdog | Out-Null
    $app = $null
    try {
      Stop-Service -Name $stopped -Force
      $app = Start-Process -FilePath $CounterExe -Credential $counterCredential -LoadUserProfile -WorkingDirectory (Split-Path $CounterExe) -PassThru
      $deadline = (Get-Date).AddSeconds(180)
      $text = ''
      do {
        Start-Sleep -Seconds 3
        if (Test-Path $counterLog) { $text = Get-Content -Raw $counterLog }
      } while (-not ($text -match "service start requested.*$stopped" -and $text -match '"page loaded","page":"https://127\.0\.0\.1:8443/') -and (Get-Date) -lt $deadline)
      ($text -split "`n") | Select-Object -Last 8 | ForEach-Object { if ($_) { Write-Step "  app log: $_" } }
      if ($text -notmatch "service start requested.*$stopped") { throw 'the app did not start the service' }
      if ($text -notmatch '"page loaded","page":"https://127\.0\.0\.1:8443/') { throw 'the app did not open' }
      if ((Get-Service $stopped).Status -ne 'Running') { throw 'the service is not running' }
    } finally {
      Get-Process -Name 'CoffeeLounge' -ErrorAction SilentlyContinue | Stop-Process -Force
      Enable-ScheduledTask -TaskName $watchdog | Out-Null
      # Stopping the database also stopped what depends on it.
      foreach ($s in $startupServices) { if ((Get-Service $s).Status -ne 'Running') { Start-Service -Name $s } }
    }
    Wait-Ready 120
  }
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
  # A client backend (not the logger or another helper process): its command line says so.
  $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$($postmaster.ProcessId) AND Name='postgres.exe'")
  $backend = $children | Where-Object { $_.CommandLine -match 'backend' -and $_.CommandLine -notmatch 'log' } | Select-Object -First 1
  if (-not $backend) { throw ("no client backend among: " + (($children | ForEach-Object { $_.CommandLine }) -join ' | ')) }
  Stop-Process -Id $backend.ProcessId -Force
  Start-Sleep -Seconds 5
  if ((Get-Service 'postgresql-x64-17').Status -ne 'Running') { throw 'PostgreSQL service stopped' }
  if (-not (Wait-Ready 120)) { throw 'API not ready again' }
  $log = Get-ChildItem (Join-Path $DataDir 'pgdata\log') | Sort-Object LastWriteTime | Select-Object -Last 1
  # Evidence only: how PostgreSQL logs a killed child depends on its exit code.
  Get-Content $log.FullName -Tail 8 | ForEach-Object { Write-Step "  pg log: $_" }
  ((Get-Service 'coffeelounge-api').Status -eq 'Running') -and ((Get-Service 'coffeelounge-worker').Status -eq 'Running')
}

Check 'backups: WAL segments are archived to the drive, encrypted, by PostgreSQL itself (step 7.1)' {
  $super = Unprotect-FromFile (Join-Path $DataDir 'config\postgres.secret')
  $env:PGPASSWORD = $super
  try {
    & (Join-Path $PgDir 'bin\psql.exe') -h 127.0.0.1 -p $PgPort -U postgres -d coffee_lounge -At -c 'SELECT pg_switch_wal()' | Out-Null
  } finally { Remove-Item Env:\PGPASSWORD }
  $wal = ((Get-Content (Join-Path $DataDir 'config\server.env')) | Where-Object { $_ -like 'BACKUP_WAL_DIR=*' }).Substring('BACKUP_WAL_DIR='.Length)
  # The archiver itself must say the segment just switched went out, not merely that old files exist.
  $env:PGPASSWORD = $super
  try {
    for ($i = 0; $i -lt 30; $i++) {
      $ok = & (Join-Path $PgDir 'bin\psql.exe') -h 127.0.0.1 -p $PgPort -U postgres -d coffee_lounge -At -c "SELECT last_archived_time > now() - interval '2 minutes' AND (last_failed_time IS NULL OR last_failed_time < last_archived_time) FROM pg_stat_archiver"
      if ($ok -eq 't') { break }
      Start-Sleep -Seconds 2
    }
  } finally { Remove-Item Env:\PGPASSWORD }
  if ($ok -ne 't') { throw 'the archiver did not archive the switched segment (or keeps failing)' }
  $files = @(Get-ChildItem $wal -Filter '*.gz.age' -ErrorAction SilentlyContinue)
  if ($files.Count -eq 0) {
    $log = Get-ChildItem (Join-Path $DataDir 'pgdata\log') | Sort-Object LastWriteTime | Select-Object -Last 1
    Get-Content $log.FullName -Tail 12 | ForEach-Object { Write-Step "  pg log: $_" }
    throw "no archived segment in $wal"
  }
  $head = [Text.Encoding]::ASCII.GetString([IO.File]::ReadAllBytes($files[0].FullName), 0, 21)
  if ($head -ne 'age-encryption.org/v1') { throw "not an age file: $head" }
  $true
}
Check 'backups: a dump made as the service login, encrypted, the private key not on this PC (step 7.1)' {
  $out = & $Node "--env-file=$(Join-Path $DataDir 'config\server.env')" (Join-Path $InstallDir 'app\dist\admin.js') backup-now 2>&1
  if ($LASTEXITCODE -ne 0) { throw "backup-now: $out" }
  $dump = Get-ChildItem (Join-Path $BackupDrive 'CoffeeLounge\dumps') -Filter '*.dump.age' | Select-Object -First 1
  $bytes = [IO.File]::ReadAllBytes($dump.FullName)
  if ([Text.Encoding]::ASCII.GetString($bytes).Contains('PGDMP')) { throw 'the dump is not encrypted' }
  $left = Get-ChildItem -Recurse -ErrorAction SilentlyContinue -Path $DataDir, $InstallDir -Filter 'coffee-lounge-backup-key.txt'
  if ($left) { throw "private key found on this PC: $($left.FullName -join ', ')" }
  if ($CaExportDir -and -not (Test-Path (Join-Path $CaExportDir 'coffee-lounge-backup-key.txt'))) { throw 'private key not exported' }
  $true
}

Check 'backups: a base backup through the backup login, and a test restore that passes every integrity check (step 7.2)' {
  $envFile = Join-Path $DataDir 'config\server.env'
  $out = & $Node "--env-file=$envFile" (Join-Path $InstallDir 'app\dist\admin.js') backup-base 2>&1
  if ($LASTEXITCODE -ne 0) { throw "backup-base: $out" }
  $base = @(Get-ChildItem -Recurse (Join-Path $BackupDrive 'CoffeeLounge\base') -Filter 'base.tar.gz.age')
  if ($base.Count -eq 0) { throw 'no base backup written' }
  $out = & $Node "--env-file=$envFile" (Join-Path $InstallDir 'app\dist\admin.js') backup-now --test-restore 2>&1
  if ($LASTEXITCODE -ne 0) { throw "backup-now --test-restore: $out" }
  if (-not ("$out" -match 'every integrity check passed')) { throw "no test restore: $out" }
  $id = Get-Content -Raw (Join-Path $BackupDrive 'CoffeeLounge\drive.json') | ConvertFrom-Json
  if ($id.label -ne 'A') { throw "drive label: $($id.label)" }
  $true
}

if ($script:Failures.Count -gt 0) {
  Write-Step "$($script:Failures.Count) check(s) failed: $($script:Failures -join '; ')"
  exit 1
}
Write-Step 'All Windows checks passed.'
