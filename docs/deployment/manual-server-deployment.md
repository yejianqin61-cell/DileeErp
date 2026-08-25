# 服务器手动更新部署

GitHub push 只执行代码检查，不再自动发布镜像或上传镜像。服务器使用源码压缩包更新。

本机 PowerShell 执行：

```powershell
tar -czf DileeErp-latest.tar.gz --exclude=.git --exclude=node_modules --exclude=.next --exclude=dist --exclude=coverage --exclude=test-results --exclude='*.tar' --exclude='*.tar.gz' --exclude=.env --exclude=.env.local --exclude=.env.factory .
scp .\DileeErp-latest.tar.gz ubuntu@159.75.219.30:/tmp/
```

服务器执行，保留生产配置：

```bash
cd /opt/dilee
pm2 stop dilee-api dilee-web 2>/dev/null || true
backup="/opt/dilee/app.backup-$(date +%Y%m%d-%H%M%S)"
mv /opt/dilee/app "$backup"
mkdir /opt/dilee/app
tar -xzf /tmp/DileeErp-latest.tar.gz -C /opt/dilee/app
cp "$backup/.env.factory" /opt/dilee/app/.env.factory
cd /opt/dilee/app
```

## Docker 部署

```bash
sudo docker compose -f docker-compose.factory.yml --env-file .env.factory build api web
sudo docker compose -f docker-compose.factory.yml --env-file .env.factory up -d postgres
sudo docker compose -f docker-compose.factory.yml --env-file .env.factory up -d api web
sudo docker compose -f docker-compose.factory.yml --env-file .env.factory ps
curl http://127.0.0.1:3001/api/v1/health
```

## PM2 部署

```bash
cd /opt/dilee/app

# 仅使用 Docker 运行 PostgreSQL；API 和前端由 PM2 运行
sudo docker compose -f docker-compose.factory.yml --env-file .env.factory up -d postgres

# 构建需要 Nest CLI、Prisma CLI 等开发依赖，不能使用 production-only 安装
npm ci --include=dev
npx prisma generate --schema apps/api/prisma/schema.prisma

# .env.factory 是 Compose 格式，PM2 需要把数据库地址指向宿主机
set -a
. ./.env.factory
set +a
export DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:15432/${POSTGRES_DB}?schema=public"
export NODE_ENV=production
export COOKIE_SECURE=false

npx prisma migrate deploy --schema apps/api/prisma/schema.prisma
npm run build --workspace=@dilee/api
npm run build --workspace=@dilee/web

# PM2 直接运行 standalone 时必须补齐 Next 静态资源
mkdir -p apps/web/.next/standalone/apps/web/.next
cp -a apps/web/.next/static apps/web/.next/standalone/apps/web/.next/
if [ -d apps/web/public ]; then cp -a apps/web/public apps/web/.next/standalone/apps/web/; fi

sudo npm install -g pm2
pm2 delete dilee-api 2>/dev/null || true
pm2 delete dilee-web 2>/dev/null || true

export PORT=3001
pm2 start apps/api/dist/main.js --name dilee-api --update-env

export API_INTERNAL_URL=http://127.0.0.1:3001
export PORT=3000
export HOSTNAME=0.0.0.0
pm2 start apps/web/.next/standalone/apps/web/server.js --name dilee-web --update-env

pm2 save
pm2 status
curl http://127.0.0.1:3001/api/v1/health
```

首次配置开机自启：

```bash
pm2 startup systemd
# 按命令输出复制并执行 sudo 提示的那一行
pm2 save
```

PM2 更新时先执行 `pm2 delete dilee-api dilee-web`，再重新构建和启动，避免 `EADDRINUSE`。

## 纯非 Docker 数据库

如果服务器已安装本机 PostgreSQL，可以停止 Compose 的数据库容器，并将 `DATABASE_URL` 改为本机 PostgreSQL 地址；其余 PM2 步骤不变。
