param([string]$Output = "DileeErp-latest.tar.gz")
$ErrorActionPreference = "Stop"

# 必须用 Windows 原生 tar：若解析到 Git 自带的 MSYS tar，会把 C:\... 当成远程主机
# 并报 "Cannot connect to C: resolve failed"，导致打包静默失败。
$tarExe = Join-Path $env:SystemRoot "System32\tar.exe"
if (-not (Test-Path $tarExe)) { $tarExe = "tar" }

$repoRoot = (git rev-parse --show-toplevel).Trim()
if (-not $repoRoot) { throw "当前目录不在 Git 仓库内" }
# 注意：Windows PowerShell 5.1（.NET Framework）没有 GetFullPath(path, basePath) 双参重载，
# 只能用 Join-Path + 单参 GetFullPath，否则报 "Cannot find an overload for GetFullPath"。
$outputPath = if ([System.IO.Path]::IsPathRooted($Output)) { $Output } else { Join-Path (Get-Location).Path $Output }
$outputPath = [System.IO.Path]::GetFullPath($outputPath)
Push-Location $repoRoot
try {
  $version = (git rev-parse HEAD).Trim()
  git diff --quiet
  $workingTreeDirty = $LASTEXITCODE -ne 0
  git diff --cached --quiet
  $indexDirty = $LASTEXITCODE -ne 0
  if ($workingTreeDirty -or $indexDirty) { throw "工作区存在已跟踪的未提交改动，请先提交后再生成发布包" }

  $staging = Join-Path ([System.IO.Path]::GetTempPath()) ("dilee-release-" + [guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Path $staging | Out-Null
  try {
    $sourceArchive = Join-Path $staging "source.tar"
    git archive --format=tar --output=$sourceArchive HEAD
    & $tarExe -xf $sourceArchive -C $staging
    if ($LASTEXITCODE -ne 0) { throw "解包失败（tar = $tarExe）" }
    # RELEASE_VERSION 必须是 UTF-8 无 BOM：服务器用 `tr -d '\r\n' < RELEASE_VERSION` 读取，
    # 带 BOM 会让 health 的 build 字段与版本号比对失败。
    [System.IO.File]::WriteAllText(
      (Join-Path $staging "RELEASE_VERSION"),
      $version,
      (New-Object System.Text.UTF8Encoding($false))
    )
    Remove-Item -LiteralPath $sourceArchive -Force
    & $tarExe -czf $outputPath -C $staging .
    if ($LASTEXITCODE -ne 0) { throw "打包失败（tar = $tarExe）" }
  } finally { Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue }

  # 包结构自检（标准 §本地打包与上传）：顶层必须是仓库内容，禁止夹带本机目录
  $entries = & $tarExe -tzf $outputPath
  foreach ($expected in @("./package.json", "./package-lock.json", "./apps/", "./ecosystem.config.cjs", "./scripts/", "./RELEASE_VERSION")) {
    if ($entries -notcontains $expected) { throw "发布包缺少顶层条目：$expected" }
  }
  $forbidden = $entries | Where-Object { $_ -match '^\./(\.android|\.claude|AppData|Users|\.pnpm-store|\.dsh-meow|node_modules)/' }
  if ($forbidden) { throw "发布包出现禁止目录：$($forbidden -join ', ')" }

  Write-Output "Created $outputPath with RELEASE_VERSION=$version ($($entries.Count) entries)"
} finally { Pop-Location }
