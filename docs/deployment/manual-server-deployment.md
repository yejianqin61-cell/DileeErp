# 服务器手动更新部署

GitHub push 只执行代码检查，不再自动发布镜像或上传镜像。服务器更新时登录服务器执行：

```bash
cd /opt/dilee/app
git pull --ff-only origin main
```

## Docker 部署

```bash
sudo docker compose -f docker-compose.factory.yml --env-file .env.factory build api web
sudo docker compose -f docker-compose.factory.yml --env-file .env.factory up -d postgres
sudo docker compose -f docker-compose.factory.yml --env-file .env.factory up -d api web
sudo docker compose -f docker-compose.factory.yml --env-file .env.factory ps
curl http://127.0.0.1:3001/api/v1/health
```

## 非 Docker 部署

```bash
npm ci
npx prisma generate --schema apps/api/prisma/schema.prisma
npx prisma migrate deploy --schema apps/api/prisma/schema.prisma
npm run build --workspace=@dilee/api
npm run build --workspace=@dilee/web
```

非 Docker 进程的端口和进程托管方式由服务器现有的 PM2 或 systemd 配置决定；更新前先停止旧进程，避免 `EADDRINUSE`。
