# Shared helpers for the Windows build and installer scripts.
# Windows PowerShell 5.1 compatible (the shop PC has no PowerShell 7): no ??, no ternary,
# no && / ||, and every native command's exit code is checked.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Add-Type -AssemblyName System.Security
Add-Type -AssemblyName System.IO.Compression.FileSystem

$script:LogFile = $null
$script:MissingPins = @()

function Write-Step([string]$Message) {
  $line = '[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
  Write-Host $line
  if ($script:LogFile) { Add-Content -Path $script:LogFile -Value $line }
}

# Runs a native program; stops on a non-zero exit code. Secrets passed with -Hide are
# masked in the log line.
function Invoke-Native {
  param(
    [Parameter(Mandatory)] [string]$FilePath,
    [string[]]$Arguments = @(),
    [string[]]$Hide = @(),
    [string]$InputText = $null,
    [hashtable]$Environment = @{}
  )
  $shown = ($Arguments | ForEach-Object { $a = $_; foreach ($h in $Hide) { if ($h) { $a = $a.Replace($h, '***') } }; $a }) -join ' '
  Write-Step ("> {0} {1}" -f (Split-Path $FilePath -Leaf), $shown)
  $saved = @{}
  foreach ($k in $Environment.Keys) {
    $saved[$k] = [Environment]::GetEnvironmentVariable($k, 'Process')
    [Environment]::SetEnvironmentVariable($k, [string]$Environment[$k], 'Process')
  }
  # Windows PowerShell 5.1 turns stderr lines of a native program into terminating
  # errors under 'Stop': relax it for the call and judge by the exit code instead.
  $savedPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    if ($InputText) {
      $output = $InputText | & $FilePath @Arguments 2>&1
    } else {
      $output = & $FilePath @Arguments 2>&1
    }
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $savedPreference
    foreach ($k in $saved.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k], 'Process') }
  }
  $text = ($output | ForEach-Object { "$_" }) -join "`n"
  foreach ($h in $Hide) { if ($h) { $text = $text.Replace($h, '***') } }
  if ($text) { Write-Step $text }
  if ($code -ne 0) { throw ("{0} failed with exit code {1}" -f (Split-Path $FilePath -Leaf), $code) }
  return $text
}

# Downloads a pinned component into the cache and checks its SHA-256.
function Get-Component {
  param([Parameter(Mandatory)] $Spec, [Parameter(Mandatory)] [string]$CacheDir)
  New-Item -ItemType Directory -Force -Path $CacheDir | Out-Null
  $file = Join-Path $CacheDir (Split-Path $Spec.url -Leaf)
  if (-not (Test-Path $file)) {
    Write-Step "Downloading $($Spec.url)"
    Invoke-WebRequest -Uri $Spec.url -OutFile $file -UseBasicParsing
  }
  $hash = (Get-FileHash -Path $file -Algorithm SHA256).Hash.ToLowerInvariant()
  if (-not $Spec.sha256) {
    $script:MissingPins += "$($Spec.url) has sha256 $hash"
    return $null
  }
  if ($hash -ne $Spec.sha256.ToLowerInvariant()) {
    Remove-Item -Force $file
    throw "Checksum mismatch for $($Spec.url): expected $($Spec.sha256), got $hash"
  }
  return $file
}

function Expand-Zip([string]$Zip, [string]$Destination) {
  if (Test-Path $Destination) { Remove-Item -Recurse -Force $Destination }
  [IO.Compression.ZipFile]::ExtractToDirectory($Zip, $Destination)
}

# Random secret without characters that need escaping in URLs or config files.
function New-Secret([int]$Bytes = 24) {
  $buffer = New-Object byte[] $Bytes
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($buffer) } finally { $rng.Dispose() }
  return ([Convert]::ToBase64String($buffer) -replace '[+/=]', '')
}

# Windows DPAPI, machine scope: only this PC can read it back (WINDOWS_DEPLOYMENT.md §6).
function Protect-ToFile([string]$Text, [string]$Path) {
  $bytes = [Text.Encoding]::UTF8.GetBytes($Text)
  $sealed = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::LocalMachine)
  [IO.File]::WriteAllBytes($Path, $sealed)
}

function Unprotect-FromFile([string]$Path) {
  $sealed = [IO.File]::ReadAllBytes($Path)
  $bytes = [Security.Cryptography.ProtectedData]::Unprotect($sealed, $null, [Security.Cryptography.DataProtectionScope]::LocalMachine)
  return [Text.Encoding]::UTF8.GetString($bytes)
}

# Replaces inherited permissions: SYSTEM and Administrators full control, plus the given
# accounts (e.g. 'NT SERVICE\coffeelounge-api') with read or modify rights.
function Set-RestrictedAcl {
  param([Parameter(Mandatory)] [string]$Path, [string[]]$Read = @(), [string[]]$Modify = @())
  $isDir = (Get-Item $Path).PSIsContainer
  $inherit = ''
  if ($isDir) { $inherit = '(OI)(CI)' }
  $grants = @("*S-1-5-18:$($inherit)F", "*S-1-5-32-544:$($inherit)F")
  foreach ($a in $Read) { $grants += "$($a):$($inherit)RX" }
  foreach ($a in $Modify) { $grants += "$($a):$($inherit)M" }
  $icaclsArgs = @($Path, '/inheritance:r')
  foreach ($g in $grants) { $icaclsArgs += @('/grant:r', $g) }
  Invoke-Native -FilePath 'icacls.exe' -Arguments $icaclsArgs | Out-Null
}

function Test-Admin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  return (New-Object Security.Principal.WindowsPrincipal $identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Test-PortFree([int]$Port) {
  $listening = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
  return -not $listening
}

# Prints what Windows recorded about a service that would not start (event logs).
function Show-ServiceFailure([string]$Name, [string[]]$Providers = @()) {
  $since = (Get-Date).AddMinutes(-15)
  Write-Step "Diagnosing $Name"
  $sc = (& sc.exe queryex $Name) -join "`n"
  Write-Step $sc
  $events = @()
  $events += Get-WinEvent -FilterHashtable @{ LogName = 'System'; StartTime = $since } -ErrorAction SilentlyContinue |
    Where-Object { $_.ProviderName -eq 'Service Control Manager' -and $_.Message -match [regex]::Escape($Name) }
  $events += Get-WinEvent -FilterHashtable @{ LogName = 'Application'; StartTime = $since } -ErrorAction SilentlyContinue |
    Where-Object { $p = $_.ProviderName; ($Providers | Where-Object { $p -like "*$_*" }) }
  foreach ($e in ($events | Sort-Object TimeCreated | Select-Object -Last 25)) {
    Write-Step ("  {0} {1} [{2}] {3}" -f $e.TimeCreated.ToString('HH:mm:ss'), $e.ProviderName, $e.Id, ($e.Message -replace '\s+', ' '))
  }
}

# Lets one Windows account see and start a service, and nothing more: no stop, no
# configuration (Phase 8 step 8.5). Safe to run again.
function Grant-ServiceStart([string]$Service, [string]$Account) {
  $sid = (New-Object Security.Principal.NTAccount($Account)).Translate([Security.Principal.SecurityIdentifier]).Value
  $sddl = ((& sc.exe sdshow $Service) -join '').Trim()
  if ($LASTEXITCODE -ne 0 -or $sddl -notmatch '^D:') { throw "Could not read the permissions of $Service." }
  if ($sddl -match [regex]::Escape(";;;$sid)")) { return }
  $ace = "(A;;LCRPRC;;;$sid)"
  $saclAt = $sddl.IndexOf('S:')
  if ($saclAt -ge 0) { $updated = $sddl.Insert($saclAt, $ace) } else { $updated = $sddl + $ace }
  Invoke-Native -FilePath 'sc.exe' -Arguments @('sdset', $Service, $updated) | Out-Null
}

# Writes UTF-8 without a byte-order mark (Set-Content -Encoding UTF8 in 5.1 adds one,
# which JSON parsers reject).
function Write-Utf8NoBom([string]$Path, [string]$Text) {
  [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding($false)))
}
