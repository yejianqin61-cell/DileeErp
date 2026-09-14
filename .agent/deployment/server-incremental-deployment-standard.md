# 迪礼 ERP 服务器增量部署标准

此文档是生产部署的唯一标准。服务器不作为 Git 工作区；每次发布均从本地已提交的 `HEAD` 打包，再通过 `scp` 上传。生产环境只用 Docker 运行 PostgreSQL，API 和前端由 PM2 运行。

## 本地打包与上传

```powershell
cd C:\Users\USER\Desktop\Dilee
git status --short
npm run build
powershell -ExecutionPolicy Bypass -File scripts/create-release-archive.ps1 -Output DileeErp-latest.tar.gz
tar -tzf .\DileeErp-latest.tar.gz | Select-Object -First 30
scp .\DileeErp-latest.tar.gz ubuntu@159.75.219.30:/tmp/DileeErp-latest.tar.gz
```

只允许包内直接出现 `package.json`、`package-lock.json`、`apps/`、`ecosystem.config.cjs`、`scripts/`。出现 `.android`、`.claude`、`AppData`、`Users` 等目录立即停止。`git archive` 无外层目录，解压禁止使用 `--strip-components=1`。

## 服务器部署

```bash
ssh ubuntu@159.75.219.30
set -euo pipefail
cd /opt/dilee
tar -tzf /tmp/DileeErp-latest.tar.gz | head -30
release="/opt/dilee/app.release-$(date +%Y%m%d-%H%M%S)"
mkdir "$release"
tar -xzf /tmp/DileeErp-latest.tar.gz -C "$release"
test -f "$release/package.json" -a -f "$release/package-lock.json"
test -f "$release/apps/api/prisma/schema.prisma" -a -f "$release/ecosystem.config.cjs"
test -f /opt/dilee/app/.env
cp /opt/dilee/app/.env "$release/.env"
if [ -d /opt/dilee/app/var ]; then cp -a /opt/dilee/app/var "$release/var"; fi
if [ "$(sudo docker inspect -f '{{.State.Running}}' app-postgres-1)" != "true" ]; then sudo docker start app-postgres-1; fi
sudo docker port app-postgres-1 5432/tcp
cd "$release"
node -e "require('dotenv').config(); const u = new URL(process.env.DATABASE_URL || ''); if (u.hostname !== '127.0.0.1' || u.port !== '15432') throw new Error('DATABASE_URL must use 127.0.0.1:15432')"
npm ci --include=dev
npx prisma generate --schema apps/api/prisma/schema.prisma
npx prisma migrate deploy --schema apps/api/prisma/schema.prisma
npm run build --workspace=@dilee/api
npm run build --workspace=@dilee/web
mkdir -p apps/web/.next/standalone/apps/web/.next
cp -a apps/web/.next/static apps/web/.next/standalone/apps/web/.next/
if [ -d apps/web/public ]; then cp -a apps/web/public apps/web/.next/standalone/apps/web/; fi
pm2 delete dilee-api 2>/dev/null || true
pm2 delete dilee-web 2>/dev/null || true
backup="/opt/dilee/app.backup-$(date +%Y%m%d-%H%M%S)"
mv /opt/dilee/app "$backup"
mv "$release" /opt/dilee/app
cd /opt/dilee/app
pm2 start ecosystem.config.cjs
pm2 save
pm2 status
curl -fsS http://127.0.0.1:3001/api/v1/health
test "$(curl -fsS http://127.0.0.1:3001/api/v1/health | node -pe 'JSON.parse(fs.readFileSync(0, "utf8")).data.build')" != "development"
curl -fsSI http://127.0.0.1:3000/manifest.webmanifest
curl -fsSI http://127.0.0.1:3000/login
```

生产 PostgreSQL 固定为容器 `app-postgres-1`，宿主机端口 `15432`，容器端口 `5432`。不执行 `docker compose down`、`docker volume rm` 或覆盖服务器 `.env`。候选目录安装、迁移、构建任一步失败时，旧版本继续运行，不切换目录。

## 成功判定

PM2 两个进程为 `online`；API health 返回数据库 `ok` 且 `data.build` 为 `RELEASE_VERSION`；manifest 和登录页返回 HTTP 200。浏览器出现旧 ChunkLoadError 时先 `Ctrl+F5` 或清站点缓存。

## 回滚

```bash
cd /opt/dilee
pm2 delete dilee-api dilee-web 2>/dev/null || true
mv /opt/dilee/app /opt/dilee/app.failed-$(date +%Y%m%d-%H%M%S)
mv /opt/dilee/app.backup-时间戳 /opt/dilee/app
cd /opt/dilee/app
pm2 start ecosystem.config.cjs
pm2 save
curl -fsS http://127.0.0.1:3001/api/v1/health
```

保留失败目录和备份目录用于排查，不删除数据库容器或卷。

---

## 自动化执行（推荐入口）

上面的手工步骤已固化为脚本，**命令与顺序完全一致**，另加三道闸门：

```powershell
npm run deploy                 # = scripts/deploy-incremental.ps1：完整流程（类型检查 + 构建 + 单测 + 打包 + 部署 + 核验）
npm run deploy -- -SkipTests   # 跳过单测（仍做类型检查与构建）
npm run deploy -- -Force       # HEAD 与线上版本相同也强制重发
```

| 文件 | 职责 |
|---|---|
| `scripts/deploy-incremental.ps1` | Windows 侧驱动：基线核对 → 本地校验 → 打包 → 上传 → 调用远端脚本 → 核验 → 清理 |
| `scripts/deploy/remote-build.sh` | 解包到 `app.release-<ts>`、结构/.env/DATABASE_URL 检查、`npm ci`、`prisma generate`、构建 API+Web |
| `scripts/deploy/remote-migrate.sh` | `prisma migrate deploy` + 迁移数达标校验 + 失败残留必须为 0 |
| `scripts/deploy/remote-switch.sh` | `pm2 delete` → 备份改名 → 提升候选目录 → 启动 → 成功判定 |
| `scripts/deploy/remote-verify.sh` | 只读核验：版本/迁移/健康/页面/PM2/日志/备份/磁盘 |
| `scripts/deploy/remote-rollback.sh` | 回滚到最近（或指定）`app.backup-*`，失败目录留 `app.failed-*` |
| `scripts/deploy-scripts.test.mjs` | 守卫测试：构建门禁、迁移门禁、备份只清 `app.backup-*`、`.ps1` 必须带 BOM 等 |

三道闸门（任一不过即终止，旧版本继续运行）：

1. **工作区必须干净**（发布包只含已提交内容）；
2. **服务器构建必须输出 `BUILD_OK`**，否则不迁移、不切换；
3. **迁移数必须 ≥ 仓库 `apps/api/prisma/migrations` 目录数**，且失败迁移残留为 0。

与本文手工步骤的两处有意差异（均可从脚本注释追溯）：

- **迁移位置**：本文写的是“`npm ci` → `migrate deploy` → 构建”；脚本改为“构建成功 → `migrate deploy` → 切换”。理由：代码编译不过时不应先动生产库；迁移仍严格早于切换。
- **备份保留**：脚本提供 `-KeepBackups <n>`（默认 3，`0` = 保留全部即严格遵循本文）。`app.failed-*` 永不自动清理。

## 迁移失败恢复（P3018）

迁移在事务内执行，失败即整块回滚；症状是 `_prisma_migrations` 出现 `finished_at IS NULL` 的行，之后任何迁移都会被拒绝。

```bash
# 1) 确认无副作用：目标表/列未被改动、失败行存在、已应用计数未变（用 SQL 核对，不要只看报错）
# 2) 修好 migration.sql 后，先做事务干跑（不落库）：
{ echo "BEGIN;"; cat apps/api/prisma/migrations/<名字>/migration.sql; echo "ROLLBACK;"; } \
  | sudo docker exec -i app-postgres-1 psql -U dilee -d dilee_erp -v ON_ERROR_STOP=1
# 3) 清理失败记录并重放（--schema 不可省）
cd /opt/dilee/app.release-<ts>
npx prisma migrate resolve --rolled-back <迁移名> --schema apps/api/prisma/schema.prisma
npx prisma migrate deploy --schema apps/api/prisma/schema.prisma
```

**执行迁移前必须预检**（历史数据会让迁移中止或误伤）：

- 加唯一索引 → 先查目标组合是否已有重复（守卫型迁移会 `RAISE EXCEPTION` 直接中止）；
- 删唯一索引 → 确认索引存在、且代码不再依赖该唯一键做 upsert；
- 加/删列 → 确认目标列尚不存在，并统计回填将命中的行数；
- 数据归一（如 `NULL → ''`）→ 记录前后总行数，证明**数据总量不变**。

## 脚本环境约束（踩过的坑）

- **`.ps1` 含中文必须带 UTF-8 BOM**：Windows PowerShell 5.1 按 ANSI 读取，无 BOM 会直接解析失败（`npm run release:pack` / `npm run deploy` 走的正是 5.1）。
- **必须用 `%SystemRoot%\System32\tar.exe`**：解析到 Git 自带 MSYS tar 会把 `C:\...` 当远程主机（`Cannot connect to C: resolve failed`），打包静默失败。
- **`RELEASE_VERSION` 必须 UTF-8 无 BOM**：服务器用 `tr -d '\r\n' < RELEASE_VERSION` 读取，带 BOM 会导致 health 的 `build` 与版本号比对失败。
- **PS 5.1 没有 `GetFullPath(path, basePath)` 双参重载**，路径拼接用 `Join-Path` + 单参 `GetFullPath`。
- **`.sh` 必须是 LF**（`.gitattributes` 已强制 `*.sh text eol=lf`）；手工上传的脚本仍建议 `sed -i 's/\r$//'` 归一。
