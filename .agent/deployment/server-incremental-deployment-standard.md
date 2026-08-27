# 服务器增量部署标准

## 目标

本流程用于把本地当前提交增量部署到远程 Ubuntu 服务器，默认保留生产数据与配置，只替换应用源码和构建产物。

## 先决条件

1. 确认本地代码已通过必要检查并完成提交。
2. 确认远程服务器可通过 SSH 访问。
3. 确认远程存在可回滚的 `/opt/dilee/app` 备份。
4. 确认远程数据库拓扑，不要假定一定是 Docker，也不要假定一定是宿主机 PostgreSQL。

## 部署决策顺序

1. 先识别数据库来源：Docker 容器、宿主机 PostgreSQL、或既有专用数据库实例。
2. 只使用已经确认的数据库连接串，不要现场猜密码或新建空库替代生产库。
3. 先停应用，再备份，再替换源码，再恢复配置。
4. 迁移先行，构建其次，服务启动最后。
5. 启动后先查 PM2 状态，再查 `/api/v1/health`，再查 Web 入口。

## 本地打包

```powershell
tar -czf DileeErp-latest.tar.gz --exclude=.git --exclude=node_modules --exclude=.next --exclude=dist --exclude=coverage --exclude=test-results --exclude='*.tar' --exclude='*.tar.gz' --exclude=.env --exclude=.env.local .
scp .\DileeErp-latest.tar.gz ubuntu@159.75.219.30:/tmp/
```

## 远程恢复

```bash
cd /opt/dilee
pm2 stop dilee-api dilee-web 2>/dev/null || true
backup="/opt/dilee/app.backup-$(date +%Y%m%d-%H%M%S)"
mv /opt/dilee/app "$backup"
mkdir /opt/dilee/app
tar -xzf /tmp/DileeErp-latest.tar.gz -C /opt/dilee/app
cp "$backup/.env" /opt/dilee/app/.env
cd /opt/dilee/app
```

## 数据库判定

1. 如果远程已有 Docker PostgreSQL 且数据卷是生产卷，继续使用 Docker。
2. 如果 `5432` 已被宿主机 PostgreSQL 占用，不要把 Docker 容器强行绑到同一个端口。
3. 如果 Docker 容器存在但没发布到宿主机端口，优先恢复原端口映射，再改应用 `DATABASE_URL`。
4. 如果数据库密码与 `.env` 不一致，先核对容器环境变量，不要新建空库顶替。

## Docker PostgreSQL 恢复

```bash
sudo docker ps -a --format '{{.Names}} {{.Status}} {{.Ports}}'
sudo docker inspect app-postgres-1 --format 'Status={{.State.Status}} Ports={{json .NetworkSettings.Ports}} Env={{json .Config.Env}}'
sudo docker logs --tail 60 app-postgres-1
```

如果原数据库容器是生产数据卷，先确认实际密码，再把容器重新发布到 `15432`，不要改卷、不重建数据目录。

## 应用部署

```bash
cd /opt/dilee/app
npx prisma migrate deploy --schema apps/api/prisma/schema.prisma
npm run build --workspace=@dilee/api
npm run build --workspace=@dilee/web
mkdir -p apps/web/.next/standalone/apps/web/.next
cp -a apps/web/.next/static apps/web/.next/standalone/apps/web/.next/
if [ -d apps/web/public ]; then cp -a apps/web/public apps/web/.next/standalone/apps/web/; fi
pm2 delete dilee-api 2>/dev/null || true
pm2 delete dilee-web 2>/dev/null || true
pm2 start ecosystem.config.cjs
pm2 save
pm2 status
curl -fsS http://127.0.0.1:3001/api/v1/health
curl -fsSI http://127.0.0.1:3000/login || curl -fsSI http://127.0.0.1:3000/
```

## 回滚

1. 停掉 PM2。
2. 把 `/opt/dilee/app` 换回最近一次备份。
3. 重新启动原备份对应的数据库和服务。
4. 只在确认数据卷与连接串一致后，再重复部署。

## 本次踩坑记录

1. 本机 `scp` 上传是可行的，但远程部署前必须先识别数据库拓扑。
2. 服务器上存在宿主机 PostgreSQL 和 Docker PostgreSQL 两套可能性，不能默认只剩一套。
3. 生产数据卷名和数据库密码必须从容器实际状态核对，不能只看旧 `.env`。
4. `15432` 是这次恢复后可用的 Docker PostgreSQL 端口，`5432` 是宿主机 PostgreSQL 端口。
