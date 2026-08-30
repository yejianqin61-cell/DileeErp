# 迪礼 ERP 服务器增量部署标准

此文档是生产部署的唯一标准。服务器不作为 Git 工作区；每次发布均从本地已提交的 `HEAD` 打包，再通过 `scp` 上传。生产环境只用 Docker 运行 PostgreSQL，API 和前端由 PM2 运行。

## 本地打包与上传

```powershell
cd C:\Users\USER\Desktop\Dilee
git status --short
npm run build
git archive --format=tar.gz --output .\DileeErp-latest.tar.gz HEAD
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

PM2 两个进程为 `online`；API health 返回数据库 `ok` 且 `data.build` 为本次归档提交指纹；manifest 和登录页返回 HTTP 200。浏览器出现旧 ChunkLoadError 时先 `Ctrl+F5` 或清站点缓存。

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
