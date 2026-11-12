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
# 第 2 步（本地校验）里还有一个**有条件**的 HTTP 契约测试：它需要真实数据库与已启动的 API，
# 本地不总是具备。条件满足时它会跑并且**跑挂了就阻断**（"有就跑"不能变成"跑了不算"）；
# 条件不满足时跳过并打印怎么把环境开起来（scripts/dev-test-up.ps1 + 启动 API）。
#
# 回滚：ssh 到服务器执行 scripts/deploy/remote-rollback.sh（见脚本头部说明）。

[CmdletBinding()]
param(
  [string]$DeployHost = $(if ($env:DILEE_DEPLOY_HOST) { $env:DILEE_DEPLOY_HOST } else { "ubuntu@118.178.95.156" }),
  [int]$KeepBackups = 3,          # 0 = 不清理，严格遵循标准
  [switch]$SkipValidation,
  [switch]$SkipTests,
  [switch]$Force,
  [switch]$KeepRemoteArtifacts
)

$ErrorActionPreference = "Stop"

# 2026-11：159.75.219.30 已退服（不再续费，机器已下线、22/80/443 全部不可达）。
# 指向它的部署只会白等连接超时；更危险的是该 IP 释放后可能被云厂商分配给别的客户，
# 于是「默认目标」会悄悄指向一台陌生机器。所以这里硬拒绝，而不是靠超时兜底。
if ($DeployHost -match '159\.75\.219\.30') {
  throw "拒绝部署到 159.75.219.30：该主机已于 2026-11 退服（不再续费）。请改用 -DeployHost ubuntu@118.178.95.156，或设置环境变量 DILEE_DEPLOY_HOST。"
}

$repoRoot = (git rev-parse --show-toplevel).Trim()
Set-Location $repoRoot

$sshBase = @("-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=20")
$remoteDir = "/tmp/dilee-deploy"
$archive = "DileeErp-latest.tar.gz"

function Step([string]$text) { Write-Host "`n=== $text ===" -ForegroundColor Cyan }
function Ok([string]$text) { Write-Host "  OK  $text" -ForegroundColor Green }
function Warn([string]$text) { Write-Host "  !!  $text" -ForegroundColor Yellow }
function Die([string]$text) { Write-Host "  FAIL $text" -ForegroundColor Red; exit 1 }

# 原生命令（npm/node/git/ssh/scp/tar）会往 stderr 写正常信息（例如 Prisma 的
# "Environment variables loaded from .env"、npm 警告）。在 $ErrorActionPreference='Stop' 下
# PowerShell 会把 stderr 当成终止性错误直接中断脚本，所以调用期间临时降级为 'Continue'，
# 只用 $LASTEXITCODE 判定成败。
function Invoke-Native([scriptblock]$action) {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try { return (& $action 2>&1) } finally { $ErrorActionPreference = $previous }
}

function Invoke-Local([string]$description, [scriptblock]$action) {
  Write-Host "  -> $description"
  $output = Invoke-Native $action
  if ($LASTEXITCODE -ne 0) {
    # 失败时**必须**把子进程输出打出来。这里原本是 `Invoke-Native $action | Out-Null`，
    # 失败只报「退出码 1」——实测踩过：本地单测偶发红，看不到是哪条用例，只能手工逐条重跑
    # 才判断得出是 flake 还是真错。诊断信息是部署脚本最不该省的东西。
    $output | ForEach-Object { Write-Host "     $_" }
    Die "$description（退出码 $LASTEXITCODE）"
  }
  Ok $description
}

# HTTP 契约测试（apps/api/test/http/*.test.cjs）：需要**真实数据库 + 已启动的 API**，
# 因此它是"有就跑、没有就说明怎么开"，而不是无条件硬门禁。
# 两条开启条件：TEST_DATABASE_URL 非空（库名必须含 test，tests/helpers 会强校验，防误连生产）
# 且 API_BASE_URL（默认 http://127.0.0.1:3001）的健康检查为 ok。
# 一旦跑起来它就是**阻断式**的：红了必须停下，否则等于没跑。
function Invoke-ContractTests() {
  Write-Host "  -> HTTP 契约测试（可选）"
  if (-not $env:TEST_DATABASE_URL) {
    Warn "跳过：未设置 TEST_DATABASE_URL。启用方式：跑 scripts/dev-test-up.ps1，再 dot-source `$env:TEMP\dilee-test-env.ps1"
    return
  }
  $apiBase = if ($env:API_BASE_URL) { $env:API_BASE_URL } else { "http://127.0.0.1:3001" }
  try { $health = Invoke-RestMethod -Uri "$apiBase/api/v1/health" -TimeoutSec 5 } catch { $health = $null }
  if (-not $health -or $health.data.status -ne "ok") {
    Warn "跳过：API 未就绪（$apiBase/api/v1/health 不可用）。在测试库上启动 API：`$env:DATABASE_URL=`$env:TEST_DATABASE_URL; `$env:PORT=3001; node apps/api/dist/main.js"
    return
  }
  Write-Host "     测试库：$env:TEST_DATABASE_URL"
  Write-Host "     API   ：$apiBase"
  $env:API_INTERNAL_URL = $apiBase
  Invoke-Local "HTTP 契约测试" { node --test --test-concurrency=1 apps/api/test/http/*.test.cjs | Out-Null }
}

function Invoke-Remote([string]$description, [string]$command, [switch]$Capture) {
  Write-Host "  -> $description"
  $output = Invoke-Native { ssh @sshBase $DeployHost $command }
  $code = $LASTEXITCODE
  $output | ForEach-Object { Write-Host "     $_" }
  if ($code -ne 0) { Die "$description（远端退出码 $code）" }
  if ($Capture) { return (($output | Out-String).Trim()) }
}

# ---------------------------------------------------------------- 1. 基线与范围
Step "1/6 基线与发布范围"
$localHead = (git rev-parse HEAD).Trim()
$liveVersion = (Invoke-Remote "读取线上版本" "cat /opt/dilee/app/RELEASE_VERSION" -Capture).Trim()
Write-Host "  本地 HEAD : $localHead"
Write-Host "  线上版本  : $liveVersion"

# 脏工作区判定：同样必须 `-c core.safecrlf=false`。core.autocrlf=true 时 git 会把
# 「LF will be replaced by CRLF」写到 stderr，而 $ErrorActionPreference="Stop" 会把它
# 当成 NativeCommandError 直接中断部署；`2>$null` / `2>&1` 都挡不住（实测），只能从源头静音。
git -c core.safecrlf=false diff --quiet; $dirtyWorktree = $LASTEXITCODE -ne 0
git -c core.safecrlf=false diff --cached --quiet; $dirtyIndex = $LASTEXITCODE -ne 0
# 注意 `-like '??*'` 是**错的**：PowerShell 的 `?` 是单字符通配符，'??*' 等价于「任意 3 个及以上字符」——
# 所有状态行都满足，于是"未跟踪文件数"会把已修改文件一起算进去、脏文件清单反而是空的。
# 实测被它误导过两次（每次都说"有 N 个未跟踪文件"，而 N 其实是全部条目）。判断状态码前缀只能用正则。
$untracked = (git status --porcelain | Where-Object { $_ -match '^\?\?' }).Count
if ($dirtyWorktree -or $dirtyIndex) {
  Warn "工作区存在已跟踪的未提交改动（发布包只含已提交内容）："
  git status --short | Where-Object { $_ -notmatch '^\?\?' } | ForEach-Object { Write-Host "     $_" }
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
    # `apps/web/lib/*.test.mjs` 只扫顶层，会静默漏掉 apps/web/lib/production/ 下的用例
    # （实测漏了 12 条，表现为"作者说 229 条、闸门只跑 217 条"）。要递归必须用 `**`。
    Invoke-Local "Web lib 测试" { node --test apps/web/lib/**/*.test.mjs | Out-Null }
    Invoke-Local "Web 组件测试 (vitest)" { npm run test:components --workspace=@dilee/web | Out-Null }
    Invoke-ContractTests
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
# 这里原本是 `Write-Host "  包顶层：$($entries -join ' | ')"` —— `$entries` 从未定义，
# 于是每次都多打一行空的"包顶层："（实测日志里就是那样）。改成打真正有用的大小。
Write-Host "  包大小：$([math]::Round((Get-Item $archive).Length / 1MB, 1)) MB"
Invoke-Remote "准备远端目录" "rm -rf $remoteDir && mkdir -p $remoteDir"
Write-Host "  -> 上传发布包与部署脚本"
# 十几 MB 的发布包在跨境链路上偶发被掐断（实测 "Connection reset by peer" / "Broken pipe"，
# 远端只收到 4.2MB/19.3MB）。单次失败即终止会让整轮构建白跑，所以重试三次。
$localSize = (Get-Item $archive).Length
$uploaded = $false
for ($attempt = 1; $attempt -le 3; $attempt++) {
  & scp @sshBase $archive "${DeployHost}:/tmp/$archive" | Out-Null
  if ($LASTEXITCODE -eq 0) { $uploaded = $true; break }
  Warn "上传发布包失败（第 $attempt/3 次），5 秒后重试"
  Start-Sleep -Seconds 5
}
if (-not $uploaded) { Die "上传发布包失败（已重试 3 次）" }
# 退出码为 0 不足以证明文件完整：断连可能在退出前留下截断文件，用字节数做终判。
$remoteSize = (Invoke-Remote "核对远端发布包字节数" "stat -c %s /tmp/$archive" -Capture).Trim()
if ($remoteSize -ne "$localSize") { Die "上传不完整：远端 $remoteSize 字节，本地 $localSize 字节" }
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
# 边缘（nginx）体积上限：以前这一层不在仓库里、也没人测，结果是 nginx 默认的 1m
# 在**转发之前**就把 1.5MB 的销售单 Excel 挡成 413 —— API 一条日志都没有，界面只说「读取失败」。
# 这一步既安装仓库里的站点配置（配置漂移会被拉回），也**真发一个 2MB 的上传包过边缘**，
# 413 就终止部署（见 scripts/deploy/remote-nginx.sh 头部）。
Invoke-Remote "边缘上传体积核验（413 即失败）" "CONF_SRC=/opt/dilee/app/scripts/deploy/nginx-dilee.conf bash $remoteDir/remote-nginx.sh" | Out-Null
Ok "边缘放行大文件上传"
if ($KeepRemoteArtifacts) {
  Warn "已保留远端临时文件（$remoteDir、/tmp/$archive）"
} else {
  Invoke-Remote "清理远端临时文件" "rm -rf $remoteDir /tmp/$archive /tmp/dilee-staging.env /tmp/dilee-remote-build.log" | Out-Null
}
Remove-Item -LiteralPath (Join-Path $repoRoot $archive) -Force -ErrorAction SilentlyContinue
Ok "部署完成：$liveVersion → $localHead"
Write-Host "`n回滚方式：ssh $DeployHost 'bash $remoteDir/remote-rollback.sh'（若已清理临时目录，可用 /opt/dilee/app.backup-* 手工按标准 §回滚 执行）" -ForegroundColor Yellow
