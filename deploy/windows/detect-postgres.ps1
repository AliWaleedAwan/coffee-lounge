# For the setup wizard: prints "ask" when this PC already has a PostgreSQL 17 that the shop will
# use (its postgres password is then asked), otherwise "own". Changes nothing.
. (Join-Path $PSScriptRoot 'lib.ps1')
try {
  $plan = Resolve-DbPlan 'C:\ProgramData\CoffeeLounge'
  $known = Test-Path 'C:\ProgramData\CoffeeLounge\config\postgres.secret'
  if ($plan.Mode -eq 'shared' -and -not $known) { Write-Output 'ask' } else { Write-Output 'own' }
} catch {
  Write-Output 'own'
}
