param(
  [Parameter(Mandatory = $true)][string]$BackupFile
)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $BackupFile)) { throw "Backup file not found: $BackupFile" }
$checksumFile = "$BackupFile.sha256"
if (-not (Test-Path -LiteralPath $checksumFile)) { throw "Checksum file not found: $checksumFile" }
$expected = (Get-Content -LiteralPath $checksumFile -Raw).Trim() -split '\s+' | Select-Object -First 1
$actual = (Get-FileHash -LiteralPath $BackupFile -Algorithm SHA256).Hash.ToLowerInvariant()
if ($expected.ToLowerInvariant() -ne $actual) { throw "Backup checksum mismatch." }
Write-Output "Backup checksum verified: $actual"
