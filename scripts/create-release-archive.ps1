param([string]$Output = "DileeErp-latest.tar.gz")
$ErrorActionPreference = "Stop"
$version = (git rev-parse HEAD).Trim()
if ((git status --porcelain) -ne "") { throw "工作区存在未提交改动，请先提交后再生成发布包" }
$staging = Join-Path ([System.IO.Path]::GetTempPath()) ("dilee-release-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $staging | Out-Null
try {
  $sourceArchive = Join-Path $staging "source.tar"
  git archive --format=tar --output=$sourceArchive HEAD
  tar -xf $sourceArchive -C $staging
  Set-Content -LiteralPath (Join-Path $staging "RELEASE_VERSION") -Value $version -NoNewline
  Remove-Item -LiteralPath $sourceArchive -Force
  tar -czf $Output -C $staging .
  Write-Output "Created $Output with RELEASE_VERSION=$version"
} finally { Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue }
