# Wraps the bundle in CoffeeLounge-Setup-<version>.exe with NSIS (installer.nsi).
#   powershell -ExecutionPolicy Bypass -File deploy\windows\build-installer.ps1 [-Bundle out\CoffeeLounge]
param(
  [string]$Bundle = (Join-Path $PSScriptRoot '..\..\out\CoffeeLounge'),
  [string]$OutDir = (Join-Path $PSScriptRoot '..\..\out')
)
. (Join-Path $PSScriptRoot 'lib.ps1')

$makensis = Get-Command makensis.exe -ErrorAction SilentlyContinue
if ($makensis) { $makensis = $makensis.Source } else { $makensis = Join-Path ${env:ProgramFiles(x86)} 'NSIS\makensis.exe' }
if (-not (Test-Path $makensis)) { throw "NSIS (makensis.exe) not found. Install NSIS 3 on the build machine." }

$Bundle = (Resolve-Path $Bundle).Path
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$version = (Get-Content -Raw (Join-Path $repo 'apps\server\package.json') | ConvertFrom-Json).version
$outFile = Join-Path (Resolve-Path $OutDir).Path "CoffeeLounge-Setup-$version.exe"
Invoke-Native -FilePath $makensis -Arguments @(
  '/V2', "/DVERSION=$version", "/DBUNDLE=$Bundle", "/DOUTFILE=$outFile", (Join-Path $PSScriptRoot 'installer.nsi')
) | Out-Null
$size = [math]::Round((Get-Item $outFile).Length / 1MB, 1)
Write-Step "Installer ready: $outFile ($size MB)"
