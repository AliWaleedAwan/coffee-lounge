# AT-56 and AC-PERF-1/2 in Windows CI (TEST_PLAN.md; step 7.5): the load script runs against the
# installed shop; one minute in, a power cut is simulated by killing PostgreSQL, the API and the
# worker at the same moment. The services come back by themselves (Windows' recovery actions and
# the database watchdog), the load script's retries reuse their Idempotency-Keys, and afterwards
# no committed record is lost or doubled, every integrity check passes and WAL archiving works.
# On the counter iMac the same is done by pulling the plug (step 7.7); this is the rehearsal.
param(
  [Parameter(Mandatory)] [string]$OwnerPassword,
  [string]$InstallDir = 'C:\Program Files\CoffeeLounge',
  [string]$PgDir = 'C:\Program Files\PostgreSQL\17',
  [string]$DataDir = 'C:\ProgramData\CoffeeLounge',
  [int]$PgPort = 5432,
  [int]$Minutes = 4
)
. (Join-Path $PSScriptRoot '..\lib.ps1')
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$Node = Join-Path $InstallDir 'runtime\node.exe'
$Admin = Join-Path $InstallDir 'app\dist\admin.js'
$EnvFile = Join-Path $DataDir 'config\server.env'
$RootCa = Join-Path $DataDir 'config\tls\coffee-lounge-root.pem'
$out = Join-Path $env:RUNNER_TEMP 'load.json'

function Invoke-SuperSql([string]$Sql) {
  $env:PGPASSWORD = Unprotect-FromFile (Join-Path $DataDir 'config\postgres.secret')
  try { return (& (Join-Path $PgDir 'bin\psql.exe') -h 127.0.0.1 -p $PgPort -U postgres -d coffee_lounge -At -c $Sql) }
  finally { Remove-Item Env:\PGPASSWORD }
}

$line = & $Node "--env-file=$EnvFile" $Admin registration-code --name 'Load laptop' --kind reception --ownership shop
$code = [regex]::Match("$line", '\b\d{8}\b').Value
if (-not $code) { throw "no registration code: $line" }
$env:NODE_EXTRA_CA_CERTS = $RootCa
$env:CL_LOAD_PASSWORD = $OwnerPassword
$load = Start-Process -FilePath 'node' -PassThru -NoNewWindow -RedirectStandardOutput (Join-Path $env:RUNNER_TEMP 'load-out.txt') -RedirectStandardError (Join-Path $env:RUNNER_TEMP 'load-err.txt') -ArgumentList @(
  (Join-Path $repo 'apps\server\scripts\load.ts'), '--staff', 'https://127.0.0.1:8443', '--guest', 'http://127.0.0.1:8080',
  '--code', $code, '--minutes', "$Minutes", '--lines-per-hour', '1200', '--create-menu', '--out', $out)
Start-Sleep -Seconds 70

Write-Step 'Power cut: PostgreSQL, the API and the worker killed at once'
$cut = Get-Date
Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'postgres.exe' -or ($_.Name -eq 'node.exe' -and $_.CommandLine -like '*CoffeeLounge\app\dist*') } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
& $Node (Join-Path $InstallDir 'setup\wait-ready.mjs') 'https://127.0.0.1:8443/health/ready' $RootCa 240
if ($LASTEXITCODE -ne 0) { throw 'the shop did not come back after the power cut' }
Write-Step ("Back and ready {0:N0} s after the cut" -f ((Get-Date) - $cut).TotalSeconds)

$load.WaitForExit()
Get-Content (Join-Path $env:RUNNER_TEMP 'load-out.txt') | ForEach-Object { Write-Step "  load: $_" }
Get-Content (Join-Path $env:RUNNER_TEMP 'load-err.txt') -ErrorAction SilentlyContinue | ForEach-Object { Write-Step "  load error: $_" }
$result = Get-Content -Raw $out | ConvertFrom-Json
if ($result.errors -ne 0) { throw "the load script saw $($result.errors) refused requests" }
if ($result.retries -lt 1) { throw 'the power cut did not interrupt the load (no retries)' }
if ((Invoke-SuperSql "SELECT count(*) FROM (SELECT invoice_id FROM cl.payments GROUP BY invoice_id HAVING count(*) > 1) d") -ne '0') { throw 'a bill was paid twice' }
if ((Invoke-SuperSql "SELECT count(*) FROM cl.invoices WHERE status = 'settled' AND paid_total <> total") -ne '0') { throw 'a settled bill does not add up' }
if ((Invoke-SuperSql "SELECT count(*) FROM cl.order_rounds r JOIN cl.dining_sessions s ON s.id = r.session_id JOIN cl.dining_tables t ON t.id = s.table_id WHERE t.name LIKE 'Load %'") -ne "$($result.orders)") {
  Write-Step "rounds on the load tables vs orders completed: $(Invoke-SuperSql "SELECT count(*) FROM cl.order_rounds r JOIN cl.dining_sessions s ON s.id = r.session_id JOIN cl.dining_tables t ON t.id = s.table_id WHERE t.name LIKE 'Load %'") vs $($result.orders)"
  throw 'a retried round was recorded twice (or lost)'
}
& $Node "--env-file=$EnvFile" $Admin integrity-check
if ($LASTEXITCODE -ne 0) { throw 'integrity checks failed after the power cut' }
Invoke-SuperSql 'SELECT pg_switch_wal()' | Out-Null
Start-Sleep -Seconds 5
if ((Invoke-SuperSql "SELECT last_failed_time IS NULL OR last_archived_time > last_failed_time FROM pg_stat_archiver") -ne 't') { throw 'WAL archiving is failing after the power cut' }
Write-Step ("AT-56: {0} orders, {1} retries, none doubled or lost; integrity checks pass; WAL archiving works. AC-PERF-1 p95 {2} ms p99 {3} ms; AC-PERF-2 p95 {4} ms p99 {5} ms." -f $result.orders, $result.retries, $result.busy.p95, $result.busy.p99, $result.liveMs.p95, $result.liveMs.p99)
