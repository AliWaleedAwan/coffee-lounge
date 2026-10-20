# Builds the offline Windows bundle (WINDOWS_DEPLOYMENT.md §1) from a checked-out and
# installed repository: everything the installer copies, with no further downloads.
#
#   powershell -ExecutionPolicy Bypass -File deploy\windows\build-bundle.ps1 [-Out out\CoffeeLounge]
#
# Layout of the bundle:
#   app\      server (bundled dist\, migrations\, production node_modules\)
#   web\      staff web app
#   runtime\  node.exe (pinned)
#   pgsql\    PostgreSQL binaries (bin, lib, share; pinned)
#   winsw\    WinSW-x64.exe (pinned)
#   setup\    install.ps1, uninstall.ps1, lib.ps1, service templates
param(
  [string]$Out = (Join-Path $PSScriptRoot '..\..\out\CoffeeLounge'),
  [string]$Cache = (Join-Path $PSScriptRoot '..\..\out\cache')
)
. (Join-Path $PSScriptRoot 'lib.ps1')

$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$components = Get-Content -Raw (Join-Path $PSScriptRoot 'components.json') | ConvertFrom-Json
Set-Location $repo

# Check all downloads first: a missing pin should fail fast, before the slow steps.
$nodeZip = Get-Component -Spec $components.node -CacheDir $Cache
$pgZip = Get-Component -Spec $components.postgresql -CacheDir $Cache
$winsw = Get-Component -Spec $components.winsw -CacheDir $Cache
if ($script:MissingPins.Count -gt 0) {
  throw ("Downloads without a pinned sha256 (review each and pin it in components.json):`n" + ($script:MissingPins -join "`n"))
}

if (Test-Path $Out) { Remove-Item -Recurse -Force $Out }
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$Out = (Resolve-Path $Out).Path

Write-Step 'Building the web app and the server bundle'
Invoke-Native -FilePath 'corepack' -Arguments @('pnpm', '--filter', '@cl/web', 'build') | Out-Null
Invoke-Native -FilePath 'corepack' -Arguments @('pnpm', '--filter', '@cl/server', 'bundle') | Out-Null

Write-Step 'Deploying the server with production dependencies (flat node_modules)'
Invoke-Native -FilePath 'corepack' -Arguments @(
  'pnpm', '--filter', '@cl/server', 'deploy', '--prod', '--config.node-linker=hoisted', (Join-Path $Out 'app')
) | Out-Null
foreach ($extra in @('pnpm-lock.yaml', 'pnpm-workspace.yaml', 'node_modules\.bin')) {
  $p = Join-Path $Out "app\$extra"
  if (Test-Path $p) { Remove-Item -Recurse -Force $p }
}
Copy-Item -Recurse -Path (Join-Path $repo 'apps\web\dist') -Destination (Join-Path $Out 'web')

Write-Step 'Adding the pinned runtime, PostgreSQL and service wrapper'
$tmp = Join-Path $Cache 'extract'
Expand-Zip $nodeZip $tmp
$nodeDir = Get-ChildItem $tmp -Directory | Select-Object -First 1
New-Item -ItemType Directory -Force -Path (Join-Path $Out 'runtime') | Out-Null
Copy-Item (Join-Path $nodeDir.FullName 'node.exe') (Join-Path $Out 'runtime')
Copy-Item (Join-Path $nodeDir.FullName 'LICENSE') (Join-Path $Out 'runtime\LICENSE.txt')

Expand-Zip $pgZip $tmp
New-Item -ItemType Directory -Force -Path (Join-Path $Out 'pgsql') | Out-Null
foreach ($part in @('bin', 'lib', 'share')) {
  Copy-Item -Recurse (Join-Path $tmp "pgsql\$part") (Join-Path $Out "pgsql\$part")
}
Remove-Item -Recurse -Force $tmp

New-Item -ItemType Directory -Force -Path (Join-Path $Out 'winsw') | Out-Null
Copy-Item $winsw (Join-Path $Out 'winsw\WinSW-x64.exe')

Write-Step 'Adding the setup scripts'
$setup = Join-Path $Out 'setup'
New-Item -ItemType Directory -Force -Path $setup | Out-Null
foreach ($f in @('install.ps1', 'uninstall.ps1', 'lib.ps1', 'wait-ready.mjs')) { Copy-Item (Join-Path $PSScriptRoot $f) $setup }
Copy-Item -Recurse (Join-Path $PSScriptRoot 'services') (Join-Path $setup 'services')

$version = (Get-Content -Raw (Join-Path $repo 'apps\server\package.json') | ConvertFrom-Json).version
$commit = (git rev-parse --short HEAD)
Set-Content -Path (Join-Path $Out 'VERSION.txt') -Value "Coffee Lounge $version ($commit)`nnode $($components.node.version), postgresql $($components.postgresql.version), winsw $($components.winsw.version)"
$size = [math]::Round(((Get-ChildItem -Recurse $Out | Measure-Object -Property Length -Sum).Sum / 1MB), 1)
Write-Step "Bundle ready: $Out ($size MB)"
