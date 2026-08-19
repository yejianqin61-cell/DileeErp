param(
  [Parameter(Mandatory = $true)][string]$DatabaseUrl,
  [Parameter(Mandatory = $true)][string]$BackupFile
)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $BackupFile)) { throw "Backup file not found: $BackupFile" }
pg_restore --clean --if-exists --no-owner --dbname=$DatabaseUrl $BackupFile
Write-Output "Restore completed: $BackupFile"
