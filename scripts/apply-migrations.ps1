param(
  [Parameter(Mandatory = $true)]
  [string]$DatabaseUrl
)

if ([string]::IsNullOrWhiteSpace($DatabaseUrl)) {
  throw "DatabaseUrl is required."
}

$env:DATABASE_URL = $DatabaseUrl
Write-Host "Applying Prisma migrations to: $($DatabaseUrl -replace '://.*@', '://***@')"
npx prisma migrate deploy --schema apps/api/prisma/schema.prisma
exit $LASTEXITCODE
