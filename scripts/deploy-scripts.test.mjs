// 部署脚本守卫测试。
//
// 背景：部署脚本本身出错的代价很高（打包静默失败、构建没过就切换、迁移次数不足、
// 备份被误删、PS 5.1 读不了含中文的无 BOM 脚本）。这里把踩过的坑固化成断言。
//
// 运行：node --test scripts/deploy-scripts.test.mjs
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (rel) => readFileSync(new URL(rel, `file://${root.replaceAll("\\", "/")}/`), "utf8");
const bytes = (rel) => readFileSync(new URL(rel, `file://${root.replaceAll("\\", "/")}/`));
const firstBytes = (rel) => bytes(rel).subarray(0, 3);

const driver = read("scripts/deploy-incremental.ps1");
const common = read("scripts/deploy/common.sh");
const build = read("scripts/deploy/remote-build.sh");
const migrate = read("scripts/deploy/remote-migrate.sh");
const switchSh = read("scripts/deploy/remote-switch.sh");
const rollback = read("scripts/deploy/remote-rollback.sh");
const verify = read("scripts/deploy/remote-verify.sh");
const packer = read("scripts/create-release-archive.ps1");
const pm2Api = read("scripts/pm2-api-start.sh");
const compose = read("docker-compose.yml");
const envExample = read(".env.example");

test("驱动脚本按「构建 → 迁移 → 切换 → 核验」顺序执行，构建是硬门禁", () => {
  const iBuild = driver.indexOf("remote-build.sh");
  const iMigrate = driver.indexOf("remote-migrate.sh");
  const iSwitch = driver.indexOf("remote-switch.sh");
  const iVerify = driver.indexOf("remote-verify.sh");
  assert.ok(iBuild > 0 && iMigrate > iBuild && iSwitch > iMigrate && iVerify > iSwitch, "步骤顺序必须是 构建→迁移→切换→核验");
  assert.match(driver, /BUILD_OK/, "必须检查 BUILD_OK");
  assert.match(driver, /Die "未看到 BUILD_OK/, "构建未通过必须终止，不得继续迁移/切换");
});

test("驱动脚本拒绝脏工作区，并校验迁移数", () => {
  assert.match(driver, /dirtyWorktree/, "必须检测已跟踪未提交改动");
  assert.match(driver, /请先提交/, "脏工作区必须给出可操作提示");
  assert.match(driver, /EXPECTED_MIGRATIONS=\$expectedMigrations/, "迁移期望数必须来自仓库迁移目录数");
});

test("迁移不在构建步骤里执行（构建失败不得先动生产库）", () => {
  // 只看非注释代码行：build 脚本的注释里会提到“标准把 migrate deploy 放在构建前”这一差异说明。
  const codeOnly = (text) => text.split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");
  assert.doesNotMatch(codeOnly(build), /migrate deploy/, "remote-build.sh 不应执行迁移");
  assert.match(migrate, /migrate deploy/, "迁移只在 remote-migrate.sh 执行");
  assert.match(migrate, /failed_migrations|rolled_back_at is null/, "迁移后必须检查失败残留");
});

test("切换脚本按标准做成功判定，且只清理 app.backup-*", () => {
  assert.match(switchSh, /data\.build|health_build/, "必须比对 health 的 build 字段");
  assert.match(switchSh, /manifest\.webmanifest/, "必须校验 manifest 200");
  assert.match(switchSh, /\/login/, "必须校验登录页 200");
  assert.match(switchSh, /app\.backup-\*/, "只允许清理 app.backup-*");
  assert.match(switchSh, /KEEP_BACKUPS/, "备份保留数必须可配置，0 = 不清理");
  assert.doesNotMatch(switchSh, /rm -rf .*app\.failed/, "app.failed-* 必须保留用于排查");
});

test("回滚脚本保留失败目录，不动数据库容器/卷", () => {
  assert.match(rollback, /app\.failed-/, "失败目录必须保留");
  assert.match(rollback, /app\.backup-\*/, "回滚源为 app.backup-*");
  assert.doesNotMatch(rollback, /docker (rm|volume rm|compose down)/, "回滚不得删除数据库容器或卷");
});

test("核验脚本覆盖迁移数/失败残留/页面/日志/备份/磁盘", () => {
  for (const needle of ["migrations applied", "migrations failed", "errlog lines", "backups", "disk", "pm2 status"]) {
    assert.ok(verify.includes(needle), `核验脚本缺少：${needle}`);
  }
});

test("公共脚本固定标准里的容器/端口/健康检查口径", () => {
  assert.match(common, /app-postgres-1/, "默认 PG 容器名");
  assert.match(common, /15432|API_PORT:-3001/, "默认端口口径");
  assert.match(common, /\/api\/v1\/health/, "健康检查路径");
  assert.match(common, /check_archive_layout/, "必须校验发布包顶层结构");
});

test("生产部署在构建、PM2 与 Compose 三个入口都要求 Agent 专用配置", () => {
  for (const key of ["AGENT_READ_DATABASE_URL", "AGENT_STATE_DATABASE_URL", "AGENT_LLM_PROVIDER", "DEEPSEEK_API_KEY"]) {
    assert.match(build, new RegExp(key), `远端构建必须预检 ${key}`);
    assert.match(pm2Api, new RegExp(`\\$\\{${key}:\\?`), `PM2 启动必须要求 ${key}`);
    assert.match(compose, new RegExp(`\\$\\{${key}:\\?`), `Compose 必须要求 ${key}`);
    assert.match(envExample, new RegExp(`^${key}=`, "m"), `.env.example 必须说明 ${key}`);
  }
});

test("打包脚本使用原生 tar、RELEASE_VERSION 无 BOM、并禁止本机目录进包", () => {
  assert.match(packer, /System32.*tar\.exe/, "必须显式使用 Windows 原生 tar（避免 MSYS tar 把 C:\\ 当远程主机）");
  assert.match(packer, /UTF8Encoding\(\$false\)/, "RELEASE_VERSION 必须写成 UTF-8 无 BOM");
  assert.match(packer, /AppData\|Users/, "必须拒绝 AppData/Users 等本机目录");
  assert.match(packer, /Join-Path \(Get-Location\)\.Path/, "路径解析必须兼容 PS 5.1（无双参 GetFullPath）");
  assert.doesNotMatch(packer, /GetFullPath\(\$Output, /, "不得使用 .NET Core 才有的双参 GetFullPath");
});

test("含中文的 .ps1 必须带 UTF-8 BOM（Windows PowerShell 5.1 否则解析失败）", () => {
  for (const rel of ["scripts/create-release-archive.ps1", "scripts/deploy-incremental.ps1"]) {
    const b = firstBytes(rel);
    assert.deepEqual([...b], [239, 187, 191], `${rel} 缺少 UTF-8 BOM`);
  }
});

test("部署用 shell 脚本必须是 LF 行尾", () => {
  for (const rel of ["scripts/deploy/common.sh", "scripts/deploy/remote-build.sh", "scripts/deploy/remote-migrate.sh", "scripts/deploy/remote-switch.sh", "scripts/deploy/remote-rollback.sh", "scripts/deploy/remote-verify.sh"]) {
    const text = read(rel);
    assert.ok(!text.includes("\r"), `${rel} 含 CR，需 LF`);
  }
});

test("发布包布局与 .gitattributes 约束仍在", () => {
  assert.ok(existsSync(new URL("..", import.meta.url)), "仓库根可访问");
  const attrs = read(".gitattributes");
  assert.match(attrs, /\*\.sh text eol=lf/, ".gitattributes 必须强制 shell 脚本 LF");
});

// ---------------------------------------------------------------------------
// 2026-09-26「改进部署」：把这几轮实际踩到的坑固化成断言。
// 每一条都对应一次真实事故，而不是假想的风险。
//
// 注意这些断言看的是**代码行**（剥掉 `#` 注释）：注释里为了说明"为什么不能这么写"会**引用**
// 被禁掉的老写法，直接匹配全文会自我误伤（第一版就是这么红的）。
// ---------------------------------------------------------------------------
const codeOf = (text) => text.split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");
const driverCode = codeOf(driver);

test("本地校验失败时必须打印子进程输出（只报退出码会让人无从下手）", () => {
  // 事故：本地单测偶发红，`Invoke-Native $action | Out-Null` 把输出丢了，只看到「退出码 1」，
  // 只能手工逐条重跑才判断得出是 flake 还是真错。
  assert.doesNotMatch(driverCode, /Invoke-Native \$action \| Out-Null/, "不得丢弃本地校验输出");
  assert.match(driverCode, /\$output = Invoke-Native \$action/, "必须捕获输出以便失败时打印");
  assert.match(driverCode, /if \(\$LASTEXITCODE -ne 0\) \{[\s\S]{0,200}?\$output \| ForEach-Object \{ Write-Host/, "失败分支必须打印捕获到的输出");
});

test("git 状态码前缀必须用正则判断：'-like \\'??*\\'' 是错的", () => {
  // 事故：PowerShell 的 `?` 是单字符通配符，'??*' 等价于「任意 ≥3 个字符」——所有状态行都匹配，
  // 于是"未跟踪文件数"把已修改文件也算进去、脏文件清单反而是空的。被它误导过两次。
  assert.ok(!driverCode.includes("-like '??*'"), "不得用 -like '??*' 判断未跟踪");
  assert.ok(!driverCode.includes("-notlike '??*'"), "不得用 -notlike '??*' 过滤脏文件");
  assert.ok(driverCode.includes("-match '^\\?\\?'"), "未跟踪必须用 -match '^\\?\\?'");
  assert.ok(driverCode.includes("-notmatch '^\\?\\?'"), "脏文件清单必须用 -notmatch '^\\?\\?'");
});

test("本地校验必须递归 web lib（* 只扫顶层，会静默漏掉子目录用例）", () => {
  // 事故：apps/web/lib/*.test.mjs 漏掉 apps/web/lib/production/daily-report-view.test.mjs 的 12 条，
  // 表现为「作者说 229 条、闸门只跑了 217 条」。
  assert.match(driverCode, /apps\/web\/lib\/\*\*\/\*\.test\.mjs/, "web lib 必须用 ** 递归");
  assert.doesNotMatch(driverCode, /apps\/web\/lib\/\*\.test\.mjs/, "不得退回只扫顶层的写法");
});

test("HTTP 契约测试：有环境就跑且跑挂要阻断，缺环境要说清怎么开", () => {
  // 契约套件需要真实库 + 已启动的 API，之前每轮都靠人工另外跑（作者日志里反复写"留给部署侧"）。
  // 现在有条件地纳入闸门：条件满足必须阻断（"有就跑"不能变成"跑了不算"），不满足要给出开启步骤。
  assert.match(driverCode, /function Invoke-ContractTests/, "必须有契约测试步骤");
  assert.match(driverCode, /TEST_DATABASE_URL/, "开启条件之一：测试库连接串");
  assert.match(driverCode, /API_BASE_URL/, "开启条件之一：已启动的 API");
  assert.match(driverCode, /apps\/api\/test\/http\/\*\.test\.cjs/, "必须真的跑契约套件");
  assert.match(driverCode, /dev-test-up\.ps1/, "跳过时必须告诉人怎么把环境开起来");
  assert.match(driverCode, /Invoke-Local "HTTP 契约测试"/, "契约测试必须走 Invoke-Local（跑挂即阻断）");
});

test("打包信息行不得引用未定义变量（历史上多打了一行空的「包顶层：」）", () => {
  assert.ok(!driverCode.includes("$entries"), "驱动脚本里没有 $entries 这个变量，引用它只会打印空行");
  assert.match(driverCode, /包大小：/, "应改为打印真正有用的信息（包大小）");
});
