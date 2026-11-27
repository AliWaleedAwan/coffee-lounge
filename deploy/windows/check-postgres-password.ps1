# For the setup wizard: prints "ok" when CL_PG_SUPERPASSWORD logs in to the PostgreSQL 17 already
# on this PC as postgres, otherwise "no". Uses that PostgreSQL's own psql; changes nothing.
. (Join-Path $PSScriptRoot 'lib.ps1')
$ErrorActionPreference = 'Continue'
try {
  $plan = Resolve-DbPlan 'C:\ProgramData\CoffeeLounge'
  $psql = Join-Path $plan.PgDir 'bin\psql.exe'
  $env:PGPASSWORD = $env:CL_PG_SUPERPASSWORD
  $answer = & $psql -h 127.0.0.1 -p $plan.Port -U postgres -d postgres -w -At -c 'SELECT 1' 2>$null
  if ($LASTEXITCODE -eq 0 -and "$answer".Trim() -eq '1') { Write-Output 'ok' } else { Write-Output 'no' }
} catch {
  Write-Output 'no'
} finally {
  Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
}
