param([string]$Output = "DileeErp-latest.tar.gz")
$ErrorActionPreference = "Stop"
$version = (git rev-parse HEAD).Trim()
$staging = Join-Path ([System.IO.Path]::GetTempPath()) ("dilee-release-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $staging | Out-Null
try {
  tar --exclude=.git --exclude=node_modules --exclude=.next --exclude=dist --exclude=coverage --exclude=test-results --exclude='*.tar' --exclude='*.tar.gz' --exclude=.env --exclude=.env.local -czf (Join-Path $staging "source.tar.gz") .
  tar -xzf (Join-Path $staging "source.tar.gz") -C $staging
  Set-Content -LiteralPath (Join-Path $staging "RELEASE_VERSION") -Value $version -NoNewline
  Remove-Item -LiteralPath (Join-Path $staging "source.tar.gz") -Force
  tar --exclude=source.tar.gz -czf $Output -C $staging .
  Write-Output "Created $Output with RELEASE_VERSION=$version"
} finally { Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue }
