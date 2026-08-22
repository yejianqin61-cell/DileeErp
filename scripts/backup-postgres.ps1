param(
  [Parameter(Mandatory = $true)][string]$DatabaseUrl,
  [Parameter(Mandatory = $true)][string]$BackupDirectory
)

$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $BackupDirectory | Out-Null
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$output = Join-Path $BackupDirectory "dilee-erp-$timestamp.dump"
pg_dump --format=custom --file=$output $DatabaseUrl
$hash = (Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash.ToLowerInvariant()
"$hash  $([IO.Path]::GetFileName($output))" | Set-Content -LiteralPath "$output.sha256" -Encoding ascii
Write-Output "Backup created: $output"
Write-Output "Checksum created: $output.sha256"
