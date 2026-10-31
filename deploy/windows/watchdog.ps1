# The database watchdog (W-1; P7-5; step 7.4). Windows runs it every minute as SYSTEM. If
# PostgreSQL stopped without an administrator meaning it (its own process died: the pg_ctl
# service then reports a clean stop, so Windows does not restart it), it is started again and
# the restart is written to logs\pg-watchdog.log for the health page. Upgrades and restores
# put down maintenance.flag while they work, and the watchdog leaves PostgreSQL alone then.
param([string]$DataDir = 'C:\ProgramData\CoffeeLounge')
if (Test-Path (Join-Path $DataDir 'maintenance.flag')) { exit 0 }
$service = Get-Service -Name 'postgresql-x64-17' -ErrorAction SilentlyContinue
if (-not $service -or $service.Status -ne 'Stopped') { exit 0 }
$log = Join-Path $DataDir 'logs\pg-watchdog.log'
try {
  Start-Service -Name 'postgresql-x64-17'
  Add-Content -Path $log -Value ("{0} PostgreSQL had stopped; the watchdog started it again" -f (Get-Date).ToUniversalTime().ToString('o'))
} catch {
  Add-Content -Path $log -Value ("{0} PostgreSQL had stopped and could not be started: {1}" -f (Get-Date).ToUniversalTime().ToString('o'), $_.Exception.Message)
}
