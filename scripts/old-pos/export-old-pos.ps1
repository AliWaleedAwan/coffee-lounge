# Reads the old POS's Access database (read-only) and writes its products for
#   admin import-old-pos --file old-pos-menu.json
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
  $command = $connection.CreateCommand()
  $command.CommandText = 'SELECT pname, pbarcode, pprice, pinstock, pcategory FROM products ORDER BY ID'
  $reader = $command.ExecuteReader()
  $products = New-Object System.Collections.Generic.List[object]
  while ($reader.Read()) {
    $text = { param($i) if ($reader.IsDBNull($i)) { '' } else { [string]$reader.GetValue($i) } }
    $products.Add([ordered]@{
        name = (& $text 0)
        barcode = (& $text 1)
        price = $(if ($reader.IsDBNull(2)) { 0 } else { [int]$reader.GetValue(2) })
        inStock = $(if ($reader.IsDBNull(3)) { $false } else { [bool]$reader.GetValue(3) })
        category = (& $text 4)
      })
  }
  $reader.Close()
} finally {
  $connection.Close()
}
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$file = Join-Path $Out 'old-pos-menu.json'
[IO.File]::WriteAllText($file, (@{ source = (Split-Path -Leaf $Database); exportedAt = (Get-Date).ToString('o'); products = $products } | ConvertTo-Json -Depth 4), (New-Object Text.UTF8Encoding($false)))
Write-Host "$($products.Count) products written to $file"
