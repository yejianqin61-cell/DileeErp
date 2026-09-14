# 测试环境一键启动（本地与 CI 通用）
#
# 用途：把 docs/test/01-test-master-plan.md §2.2 S8 描述的"环境解阻"固化成一条命令，
#       结束"链路三层永远 exit 3 环境阻断"的状态。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts/dev-test-up.ps1              # 起 postgres + 建测试库 + 迁移 + 灌管理员
#   powershell -ExecutionPolicy Bypass -File scripts/dev-test-up.ps1 -Workers 4   # 额外克隆 4 个并行 worker 库
#   powershell -ExecutionPolicy Bypass -File scripts/dev-test-up.ps1 -WithApi     # 顺带启动 API（前台，阻塞）
#
# 产出：$env:TEMP\dilee-test-env.ps1 —— 可直接 dot-source 到当前会话：
#   . $env:TEMP\dilee-test-env.ps1
#
# 退出码：0 成功；3 环境阻断（Docker 不可用）；1 执行失败。
[CmdletBinding()]
param(
  [int]$Workers = 0,
  [switch]$WithApi,
  [switch]$SkipSeed
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $repoRoot

function Write-Step([string]$Text) { Write-Host "==> $Text" -ForegroundColor Cyan }
function Fail([string]$Text, [int]$Code) { Write-Host "BLOCKED: $Text" -ForegroundColor Red; Pop-Location; exit $Code }

# 测试库连接串。库名必须含 "test"：tests/helpers/test-context.cjs 会强制校验，
# 目的是从机制上防止测试误连生产库。
$testDatabaseUrl = if ($env:TEST_DATABASE_URL) { $env:TEST_DATABASE_URL } else { 'postgresql://dilee:dilee-test-db-2026@127.0.0.1:5432/dilee_test?schema=public' }

try {
  # 1. Docker 守护进程
  Write-Step 'checking Docker daemon'
  docker info --format '{{.ServerVersion}}' *> $null
  if ($LASTEXITCODE -ne 0) {
    Fail 'Docker daemon is not running. Start Docker Desktop (or the docker service), then re-run this script.' 3
  }

  # 2. PostgreSQL 容器
  Write-Step 'starting PostgreSQL'
  docker compose up -d postgres | Out-Null
  $containerId = (docker compose ps -q postgres).Trim()
  if (-not $containerId) { Fail 'postgres container did not start' 1 }
  $deadline = (Get-Date).AddMinutes(5)
  while ((Get-Date) -lt $deadline) {
    $status = (docker inspect --format '{{.State.Health.Status}}' $containerId 2>$null)
    if ($status -eq 'healthy') { break }
    Start-Sleep -Seconds 5
  }
  if ($status -ne 'healthy') { Fail "postgres did not become healthy (last status: $status)" 1 }
  Write-Host '    postgres is healthy'

  # 3. 测试库 + 迁移（可顺带克隆并行 worker 库）
  Write-Step 'provisioning test database(s)'
  $env:TEST_DATABASE_URL = $testDatabaseUrl
  $provisionArgs = @('scripts/provision-test-databases.mjs')
  if ($Workers -gt 0) { $provisionArgs += @('--workers', "$Workers") }
  node @provisionArgs
  if ($LASTEXITCODE -ne 0) { Fail 'test database provisioning failed' 1 }

  # 4. 管理员与字典种子
  if (-not $SkipSeed) {
    Write-Step 'seeding administrator and dictionaries (into the template test database)'
    $env:DATABASE_URL = $testDatabaseUrl
    if (-not $env:INITIAL_ADMIN_USERNAME) { $env:INITIAL_ADMIN_USERNAME = 'admin' }
    if (-not $env:INITIAL_ADMIN_PASSWORD) { $env:INITIAL_ADMIN_PASSWORD = 'DileeAdmin2026Test' }
    if (-not $env:INITIAL_ADMIN_DISPLAY_NAME) { $env:INITIAL_ADMIN_DISPLAY_NAME = 'Dilee Admin' }
    npx tsx apps/api/prisma/seed.ts
    if ($LASTEXITCODE -ne 0) { Fail 'database seed failed' 1 }
  }

  # 5. 导出环境变量，供后续会话复用
  $apiPort = if ($env:PORT) { $env:PORT } else { '3001' }
  $webPort = '3000'
  $exportPath = Join-Path $env:TEMP 'dilee-test-env.ps1'
  $lines = @(
    '# 由 scripts/dev-test-up.ps1 生成；dot-source 本文件即可让当前会话获得链路测试所需变量。'
    "`$env:TEST_DATABASE_URL = '$testDatabaseUrl'"
    "`$env:DATABASE_URL = '$testDatabaseUrl'"
    "`$env:API_BASE_URL = 'http://127.0.0.1:$apiPort'"
    "`$env:API_INTERNAL_URL = 'http://127.0.0.1:$apiPort'"
    "`$env:PLAYWRIGHT_BASE_URL = 'http://127.0.0.1:$webPort'"
    "`$env:INITIAL_ADMIN_USERNAME = '$($env:INITIAL_ADMIN_USERNAME)'"
    "`$env:INITIAL_ADMIN_PASSWORD = '$($env:INITIAL_ADMIN_PASSWORD)'"
    "`$env:COOKIE_SECURE = 'false'"
  )
  if ($Workers -gt 0) {
    for ($i = 1; $i -le $Workers; $i++) {
      $derived = ([System.Uri]$testDatabaseUrl)
      $dbName = $derived.AbsolutePath.TrimStart('/')
      $suffix = '{0:D2}' -f $i
      $base = "$($derived.Scheme)://$($derived.UserInfo)@$($derived.Host):$($derived.Port)"
      $workerUrl = "$base/${dbName}_$suffix$($derived.Query)"
      $lines += "`$env:TEST_DATABASE_URL_$i = '$workerUrl'"
    }
  }
  Set-Content -Path $exportPath -Value ($lines -join "`n") -Encoding UTF8
  Write-Step "environment written to $exportPath"

  Write-Host ''
  Write-Host 'Environment is ready for chain tests.' -ForegroundColor Green
  Write-Host 'Next steps (in a new shell):'
  Write-Host "  . `$env:TEMP\dilee-test-env.ps1"
  Write-Host '  npm run test:integration'
  Write-Host '  npm run test:api            # requires the API running'
  Write-Host '  npm run test:e2e            # requires the API and Web running'
  Write-Host ''
  Write-Host 'To start the API against the test database:'
  Write-Host "  `$env:DATABASE_URL = '$testDatabaseUrl'; node apps/api/dist/main.js"

  if ($WithApi) {
    Write-Step 'starting API (foreground; Ctrl+C to stop)'
    $env:DATABASE_URL = $testDatabaseUrl
    $env:PORT = $apiPort
    node apps/api/dist/main.js
  }
}
finally {
  Pop-Location
}
