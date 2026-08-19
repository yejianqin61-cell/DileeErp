param(
  [Parameter(Mandatory = $true)][string]$DatabaseUrl,
  [Parameter(Mandatory = $true)][string]$BackupDirectory
)

$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $BackupDirectory | Out-Null
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$output = Join-Path $BackupDirectory "dilee-erp-$timestamp.dump"
pg_dump --format=custom --file=$output $DatabaseUrl
Get-FileHash $output -Algorithm SHA256 | Format-List | Out-File "$output.sha256"
Write-Output "Backup created: $output"
