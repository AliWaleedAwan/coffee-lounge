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

# ------------------------------------------------------------------ the database server
# Which PostgreSQL the shop uses (owner's decision, Nov 2026): one already on this PC when it is
# version 17 ('shared': its postgres password is asked once), otherwise our own copy ('own'),
# beside any other version, on the first free port. Chosen once, on the first install, and kept
# in config\database.json; every other script reads it from there.

# Every PostgreSQL service on this PC, from its service command line and its data folder.
function Find-PostgresServices {
  $found = @()
  foreach ($svc in @(Get-CimInstance Win32_Service | Where-Object { $_.PathName -match 'pg_ctl(\.exe)?"?\s+runservice' })) {
    $bin = $null
    if ($svc.PathName -match '^\s*"([^"]+)"') { $bin = Split-Path -Parent $Matches[1] }
    elseif ($svc.PathName -match '^\s*(\S+)') { $bin = Split-Path -Parent $Matches[1] }
    $data = $null
    if ($svc.PathName -match '-D\s+"([^"]+)"') { $data = $Matches[1] }
    elseif ($svc.PathName -match '-D\s+(\S+)') { $data = $Matches[1] }
    $version = ''
    $port = 5432
    if ($data -and (Test-Path (Join-Path $data 'PG_VERSION'))) {
      $version = (Get-Content -TotalCount 1 (Join-Path $data 'PG_VERSION')).Trim()
      foreach ($conf in @('postgresql.conf', 'postgresql.auto.conf')) {
        $file = Join-Path $data $conf
        if (Test-Path $file) {
          foreach ($line in (Get-Content $file)) { if ($line -match '^\s*port\s*=\s*''?(\d+)') { $port = [int]$Matches[1] } }
        }
      }
    }
    $found += [pscustomobject]@{ Service = $svc.Name; Version = $version; Port = $port; BinDir = $bin; DataDir = $data; Account = $svc.StartName }
  }
  return $found
}

function Get-DbConfig([string]$DataDir) {
  $file = Join-Path $DataDir 'config\database.json'
  if (Test-Path $file) { return (Get-Content -Raw $file | ConvertFrom-Json) }
  return $null
}

# The plan for this PC. $PreferOwn: the owner does not know the existing PostgreSQL 17's password,
# so ours runs beside it instead.
function Resolve-DbPlan([string]$DataDir, [bool]$PreferOwn = $false) {
  $saved = Get-DbConfig $DataDir
  if ($saved) { return $saved }
  $ours = Join-Path $DataDir 'pgdata'
  $all = @(Find-PostgresServices)
  $mine = $all | Where-Object { $_.DataDir -and ($_.DataDir.TrimEnd('\') -eq $ours) } | Select-Object -First 1
  if ($mine) {
    # Installed before database.json existed.
    return [pscustomobject]@{ Mode = 'own'; Service = $mine.Service; Port = $mine.Port; PgDir = (Split-Path -Parent $mine.BinDir); DataDir = $ours; Account = 'NT AUTHORITY\NETWORK SERVICE' }
  }
  $shared = $all | Where-Object { $_.Version -eq '17' } | Select-Object -First 1
  if ($shared -and -not $PreferOwn) {
    $account = $shared.Account
    if (-not $account -or $account -match '^(NT AUTHORITY\\)?NetworkService$') { $account = 'NT AUTHORITY\NETWORK SERVICE' }
    return [pscustomobject]@{ Mode = 'shared'; Service = $shared.Service; Port = $shared.Port; PgDir = (Split-Path -Parent $shared.BinDir); DataDir = $shared.DataDir; Account = $account }
  }
  $service = 'postgresql-x64-17'
  if (Get-Service -Name $service -ErrorAction SilentlyContinue) { $service = 'coffeelounge-db' }
  $pgDir = 'C:\Program Files\PostgreSQL\17'
  if (Test-Path (Join-Path $pgDir 'bin')) { $pgDir = 'C:\Program Files\CoffeeLounge-PostgreSQL\17' }
  $taken = @($all | ForEach-Object { $_.Port })
  $port = 5432
  while (($taken -contains $port) -or -not (Test-PortFree $port)) {
    $port++
    if ($port -gt 5499) { throw 'No free port for the database between 5432 and 5499.' }
  }
  return [pscustomobject]@{ Mode = 'own'; Service = $service; Port = $port; PgDir = $pgDir; DataDir = $ours; Account = 'NT AUTHORITY\NETWORK SERVICE' }
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
