# Reads the old POS's Access database (read-only) and writes its products, customers and sales to
# old-pos.json.gz, for Inventory > Import > Old POS on screen, or admin import-old-pos --file.
# Run on a PC with Microsoft Access or the Access Database Engine (the shop PC needs neither).
# Old logins and passwords are never read.
#
#   powershell -ExecutionPolicy Bypass -File scripts\old-pos\export-old-pos.ps1 -Database C:\path\database.accdb -Out .local\old-pos
param(
  [Parameter(Mandatory)] [string]$Database,
  [string]$Out = ''
)
# Not in the default above: Windows PowerShell 5.1 has no $PSScriptRoot there yet.
if (-not $Out) { $Out = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) '.local\old-pos' }
$ErrorActionPreference = 'Stop'
if (-not (Test-Path $Database)) { throw "$Database is not there." }
$provider = (New-Object System.Data.OleDb.OleDbEnumerator).GetElements() |
  Where-Object { $_.SOURCES_NAME -like 'Microsoft.ACE.OLEDB.*' } |
  Sort-Object SOURCES_NAME -Descending | Select-Object -First 1 -ExpandProperty SOURCES_NAME
if (-not $provider) { throw 'Microsoft Access Database Engine is not installed on this PC.' }
$connection = New-Object System.Data.OleDb.OleDbConnection("Provider=$provider;Data Source=$Database;Mode=Read")
$connection.Open()
try {
  # Rows as ordered maps, with Access's empty values as '' or 0.
  function Read-Rows([string]$Sql, [scriptblock]$Shape) {
    $command = $connection.CreateCommand()
    $command.CommandText = $Sql
    $reader = $command.ExecuteReader()
    $rows = New-Object System.Collections.Generic.List[object]
    try {
      while ($reader.Read()) {
        $get = @{}
        for ($i = 0; $i -lt $reader.FieldCount; $i++) {
          $get[$reader.GetName($i)] = $(if ($reader.IsDBNull($i)) { $null } else { $reader.GetValue($i) })
        }
        $rows.Add((& $Shape $get))
      }
    } finally { $reader.Close() }
    return ,$rows
  }
  function S($v) { if ($null -eq $v) { '' } else { ([string]$v).Trim() } }
  function N($v) { if ($null -eq $v) { 0 } else { [int]$v } }
  # Access keeps the date and the time of day in two fields.
  function At($date, $time) {
    if ($null -eq $date) { return '1970-01-01T00:00:00' }
    $d = ([datetime]$date).ToString('yyyy-MM-dd')
    $t = $(if ($null -eq $time) { '00:00:00' } else { ([datetime]$time).ToString('HH:mm:ss') })
    return "$($d)T$t"
  }
  $products = Read-Rows 'SELECT pname, pbarcode, pprice, pinstock, pcategory FROM products ORDER BY ID' {
    param($r) [ordered]@{ name = (S $r.pname); barcode = (S $r.pbarcode); price = (N $r.pprice); inStock = [bool]$r.pinstock; category = (S $r.pcategory) }
  }
  $cashiers = @{}
  foreach ($c in (Read-Rows 'SELECT pbillno, cashiername FROM cashier' { param($r) $r })) { $cashiers[[string]$c.pbillno] = S $c.cashiername }
  $bills = Read-Rows 'SELECT ID, pbillno, pdate, ptime, ptotal, pdiscount, ppayable, ppaid, pbalance, pstatus, pcustomer_name, pcustomer_mobile, customer_location FROM reciepts ORDER BY ID' {
    param($r) [ordered]@{
      id = (N $r.ID); billNo = (N $r.pbillno); at = (At $r.pdate $r.ptime)
      total = (N $r.ptotal); discount = (N $r.pdiscount); payable = (N $r.ppayable); paid = (N $r.ppaid); balance = (N $r.pbalance)
      status = (S $r.pstatus); customerName = (S $r.pcustomer_name); mobile = (S $r.pcustomer_mobile); location = (S $r.customer_location)
      cashier = $(if ($cashiers.ContainsKey([string]$r.pbillno)) { $cashiers[[string]$r.pbillno] } else { '' })
    }
  }
  $lines = Read-Rows 'SELECT ID, pbillno, pdate, ptime, pbarcode, pname, pcategory, pqty, pprice, pamount, pstatus FROM bill ORDER BY ID' {
    param($r) [ordered]@{
      id = (N $r.ID); billNo = (N $r.pbillno); at = (At $r.pdate $r.ptime); barcode = (S $r.pbarcode); name = (S $r.pname)
      category = (S $r.pcategory); qty = (N $r.pqty); price = (N $r.pprice); amount = (N $r.pamount); status = (S $r.pstatus)
    }
  }
} finally {
  $connection.Close()
}
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$json = @{ source = (Split-Path -Leaf $Database); exportedAt = (Get-Date).ToString('o'); products = $products; bills = $bills; lines = $lines } | ConvertTo-Json -Depth 4 -Compress
$file = Join-Path $Out 'old-pos.json.gz'
$stream = [IO.File]::Create($file)
try {
  $gzip = New-Object IO.Compression.GZipStream($stream, [IO.Compression.CompressionLevel]::Optimal)
  try {
    $bytes = (New-Object Text.UTF8Encoding($false)).GetBytes($json)
    $gzip.Write($bytes, 0, $bytes.Length)
  } finally { $gzip.Dispose() }
} finally { $stream.Dispose() }
$size = [math]::Round((Get-Item $file).Length / 1MB, 1)
Write-Host "$($products.Count) products, $($bills.Count) bills, $($lines.Count) bill lines written to $file ($size MB)"
Write-Host 'It holds customers'' names and mobile numbers: keep it private, and delete it once imported.'
