# 迪礼 ERP 服务器部署标准

服务器不是 Git 工作区，所有发布统一使用 scp；生产数据库和服务器 .env 必须保留。

## 本地打包与上传

```powershell
cd C:\Users\USER\Desktop\Dilee
npm run build
tar -czf DileeErp-latest.tar.gz --exclude=.git --exclude=node_modules --exclude=.next --exclude=dist --exclude=coverage --exclude=test-results --exclude='*.tar' --exclude='*.tar.gz' --exclude=.env --exclude=.env.local .
tar -tzf .\DileeErp-latest.tar.gz | Select-Object -First 25
scp .\DileeErp-latest.tar.gz ubuntu@159.75.219.30:/tmp/DileeErp-latest.tar.gz
```

包内必须直接包含 package.json、package-lock.json、apps/、ecosystem.config.cjs；出现 .android、.claude、AppData 等用户目录时立即停止。

## 远程完整重部署

```bash
cd /opt/dilee
tar -tzf /tmp/DileeErp-latest.tar.gz | head -25
pm2 stop dilee-api dilee-web 2>/dev/null || true
backup="/opt/dilee/app.backup-$(date +%Y%m%d-%H%M%S)"
mv /opt/dilee/app "$backup"; mkdir /opt/dilee/app
tar -xzf /tmp/DileeErp-latest.tar.gz -C /opt/dilee/app
test -f /opt/dilee/app/package.json
test -f /opt/dilee/app/apps/api/prisma/schema.prisma
test -f /opt/dilee/app/ecosystem.config.cjs
cp "$backup/.env" /opt/dilee/app/.env
cd /opt/dilee/app
npm ci
npx prisma generate --schema apps/api/prisma/schema.prisma
npx prisma migrate deploy --schema apps/api/prisma/schema.prisma
npm run build --workspace=@dilee/api
npm run build --workspace=@dilee/web
mkdir -p apps/web/.next/standalone/apps/web/.next
cp -a apps/web/.next/static apps/web/.next/standalone/apps/web/.next/
cp -a apps/web/public apps/web/.next/standalone/apps/web/ 2>/dev/null || true
pm2 delete dilee-api 2>/dev/null || true
pm2 delete dilee-web 2>/dev/null || true
pm2 start ecosystem.config.cjs
pm2 save
pm2 status
curl -fsS http://127.0.0.1:3001/api/v1/health
curl -fsSI http://127.0.0.1:3000/manifest.webmanifest
curl -fsSI http://127.0.0.1:3000/login || curl -fsSI http://127.0.0.1:3000/
```

本包无外层目录，不使用 --strip-components=1。远程 Docker PostgreSQL 当前使用 15432，先用 sudo docker ps/inspect 核对，禁止改生产数据卷。迁移、构建、health 任一失败即停止并保留备份。

## 回滚

停止 PM2，把当前 app 改名为失败目录，再将最近的 app.backup-时间戳改回 app，执行 pm2 start ecosystem.config.cjs 和 pm2 save。不得删除备份或数据库卷。

