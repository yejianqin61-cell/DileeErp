# 迪礼 ERP 增量部署驱动（Windows 侧）
#
# 依据：.agent/deployment/server-incremental-deployment-standard.md（生产部署唯一标准）。
# 本脚本只把标准里的手工步骤**按同一顺序固化**，并加上三道闸门：
#   1) 工作区必须干净（发布包只含已提交内容）
#   2) 服务器构建必须成功（BUILD_OK）才允许迁移与切换
#   3) 迁移数必须达到仓库迁移目录数；失败迁移残留必须为 0
#
# 用法：
#   pwsh -File scripts/deploy-incremental.ps1                 # 完整流程（含本地校验）
#   pwsh -File scripts/deploy-incremental.ps1 -SkipTests      # 跳过单测（仍做类型检查与构建）
#   pwsh -File scripts/deploy-incremental.ps1 -SkipValidation # 只打包部署（本地不校验）
#   pwsh -File scripts/deploy-incremental.ps1 -Force          # 允许 HEAD 与线上版本相同也重发
#
# 回滚：ssh 到服务器执行 scripts/deploy/remote-rollback.sh（见脚本头部说明）。

[CmdletBinding()]
param(
  [string]$DeployHost = $(if ($env:DILEE_DEPLOY_HOST) { $env:DILEE_DEPLOY_HOST } else { "ubuntu@159.75.219.30" }),
  [int]$KeepBackups = 3,          # 0 = 不清理，严格遵循标准
  [switch]$SkipValidation,
  [switch]$SkipTests,
  [switch]$Force,
  [switch]$KeepRemoteArtifacts
)

$ErrorActionPreference = "Stop"
$repoRoot = (git rev-parse --show-toplevel).Trim()
Set-Location $repoRoot

$sshBase = @("-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=20")
$remoteDir = "/tmp/dilee-deploy"
$archive = "DileeErp-latest.tar.gz"

function Step([string]$text) { Write-Host "`n=== $text ===" -ForegroundColor Cyan }
function Ok([string]$text) { Write-Host "  OK  $text" -ForegroundColor Green }
function Warn([string]$text) { Write-Host "  !!  $text" -ForegroundColor Yellow }
function Die([string]$text) { Write-Host "  FAIL $text" -ForegroundColor Red; exit 1 }

function Invoke-Local([string]$description, [scriptblock]$action) {
  Write-Host "  -> $description"
  & $action
  if ($LASTEXITCODE -ne 0) { Die "$description（退出码 $LASTEXITCODE）" }
  Ok $description
}

function Invoke-Remote([string]$description, [string]$command, [switch]$Capture) {
  Write-Host "  -> $description"
  $output = & ssh @sshBase $DeployHost $command 2>&1
  $code = $LASTEXITCODE
  $output | ForEach-Object { Write-Host "     $_" }
  if ($code -ne 0) { Die "$description（远端退出码 $code）" }
  if ($Capture) { return ($output -join "`n") }
}

# ---------------------------------------------------------------- 1. 基线与范围
Step "1/6 基线与发布范围"
$localHead = (git rev-parse HEAD).Trim()
$liveVersion = (Invoke-Remote "读取线上版本" "cat /opt/dilee/app/RELEASE_VERSION" -Capture).Trim()
Write-Host "  本地 HEAD : $localHead"
Write-Host "  线上版本  : $liveVersion"

git diff --quiet; $dirtyWorktree = $LASTEXITCODE -ne 0
git diff --cached --quiet; $dirtyIndex = $LASTEXITCODE -ne 0
$untracked = (git status --porcelain | Where-Object { $_ -like '??*' }).Count
if ($dirtyWorktree -or $dirtyIndex) {
  Warn "工作区存在已跟踪的未提交改动（发布包只含已提交内容）："
  git status --short | Where-Object { $_ -notlike '??*' } | ForEach-Object { Write-Host "     $_" }
  Die "请先提交（或暂存）后再部署；如需带走他人未提交改动，请由对方提交。"
}
if ($untracked -gt 0) { Warn "有 $untracked 个未跟踪文件不会被发布（确认是否合理，例如 @types 缓存/临时目录）" }

if ($localHead -eq $liveVersion -and -not $Force) {
  Die "本地 HEAD 与线上版本相同（$localHead）。用 -Force 可强制重发。"
}
$pendingCommits = git log --oneline "$liveVersion..HEAD" 2>$null
if ($pendingCommits) { Write-Host "  待上线提交："; $pendingCommits | ForEach-Object { Write-Host "     $_" } }
$pendingMigrations = git diff --name-only "$liveVersion..HEAD" -- apps/api/prisma/migrations 2>$null
if ($pendingMigrations) { Write-Host "  待执行迁移："; $pendingMigrations | ForEach-Object { Write-Host "     $_" } } else { Write-Host "  待执行迁移：无" }
$expectedMigrations = (Get-ChildItem apps/api/prisma/migrations -Directory | Measure-Object).Count
Write-Host "  仓库迁移目录数：$expectedMigrations（服务器迁移数须 >= 此值）"

# ---------------------------------------------------------------- 2. 本地校验
Step "2/6 本地校验"
if ($SkipValidation) {
  Warn "已按 -SkipValidation 跳过本地校验（不推荐）"
} else {
  Invoke-Local "typecheck API" { npm run typecheck --workspace=@dilee/api | Out-Null }
  Invoke-Local "typecheck Web" { npm run typecheck --workspace=@dilee/web | Out-Null }
  # api 测试 require dist，必须先构建
  Invoke-Local "构建 API（测试依赖 dist）" { npm run build --workspace=@dilee/api | Out-Null }
  if ($SkipTests) {
    Warn "已按 -SkipTests 跳过单元/组件测试"
  } else {
    Invoke-Local "API 单元测试" { node --test apps/api/test/unit/*.test.cjs | Out-Null }
    Invoke-Local "API 根测试" { node --test apps/api/test/*.test.cjs | Out-Null }
    Invoke-Local "Web lib 测试" { node --test apps/web/lib/*.test.mjs | Out-Null }
    Invoke-Local "Web 组件测试 (vitest)" { npm run test:components --workspace=@dilee/web | Out-Null }
  }
}
$errlogBaseline = 0
try { $errlogBaseline = [int]((Invoke-Remote "记录错误日志基线行数" "wc -l < /home/ubuntu/.pm2/logs/dilee-api-error.log" -Capture).Trim()) } catch { Warn "无法读取错误日志基线（忽略）" }

# ---------------------------------------------------------------- 3. 打包与上传
Step "3/6 打包与上传"
Invoke-Local "生成发布包（拒绝脏工作区）" { & (Join-Path $PSScriptRoot "create-release-archive.ps1") -Output $archive | Out-Null }
# 先取全量再截前几行：`tar | Select-Object -First n` 会提前中断原生进程
$allEntries = & tar -tzf $archive
Write-Host "  包顶层：$((($allEntries | Select-Object -First 5) -join ' | '))  共 $($allEntries.Count) 项"
Write-Host "  包顶层：$($entries -join ' | ')"
Invoke-Remote "准备远端目录" "rm -rf $remoteDir && mkdir -p $remoteDir"
Write-Host "  -> 上传发布包与部署脚本"
& scp @sshBase $archive "${DeployHost}:/tmp/$archive" | Out-Null
if ($LASTEXITCODE -ne 0) { Die "上传发布包失败" }
& scp @sshBase (Get-ChildItem scripts/deploy/*.sh | ForEach-Object { $_.FullName }) "${DeployHost}:$remoteDir/" | Out-Null
if ($LASTEXITCODE -ne 0) { Die "上传部署脚本失败" }
Invoke-Remote "脚本行尾归一为 LF（防 CRLF 导致 bash 报错）" "sed -i 's/\r`$//' $remoteDir/*.sh && ls -1 $remoteDir" | Out-Null
Ok "上传完成"

# ---------------------------------------------------------------- 4. 服务器构建（门禁）
Step "4/6 服务器构建（门禁：不成功不迁移、不切换）"
$buildOutput = Invoke-Remote "远端构建（npm ci + prisma generate + api/web build）" "bash $remoteDir/remote-build.sh" -Capture
if ($buildOutput -notmatch "BUILD_OK") { Die "未看到 BUILD_OK，构建视为失败；线上仍运行旧版本" }
Ok "服务器构建通过"

# ---------------------------------------------------------------- 5. 迁移 + 切换
Step "5/6 迁移与切换"
Invoke-Remote "Prisma 迁移（校验迁移数与失败残留）" "EXPECTED_MIGRATIONS=$expectedMigrations bash $remoteDir/remote-migrate.sh" | Out-Null
Invoke-Remote "切换目录并重启 PM2（成功判定）" "KEEP_BACKUPS=$KeepBackups ERRLOG_BASELINE=$errlogBaseline bash $remoteDir/remote-switch.sh" | Out-Null
Ok "已切换到 $localHead"

# ---------------------------------------------------------------- 6. 核验与清理
Step "6/6 部署后核验"
Invoke-Remote "状态核验" "EXPECTED_MIGRATIONS=$expectedMigrations bash $remoteDir/remote-verify.sh" | Out-Null
if ($KeepRemoteArtifacts) {
  Warn "已保留远端临时文件（$remoteDir、/tmp/$archive）"
} else {
  Invoke-Remote "清理远端临时文件" "rm -rf $remoteDir /tmp/$archive /tmp/dilee-staging.env /tmp/dilee-remote-build.log" | Out-Null
}
Remove-Item -LiteralPath (Join-Path $repoRoot $archive) -Force -ErrorAction SilentlyContinue
Ok "部署完成：$liveVersion → $localHead"
Write-Host "`n回滚方式：ssh $DeployHost 'bash $remoteDir/remote-rollback.sh'（若已清理临时目录，可用 /opt/dilee/app.backup-* 手工按标准 §回滚 执行）" -ForegroundColor Yellow
