# 本地开发启动手册

适用环境：Windows PowerShell、本地 Docker Desktop、Node.js 22+。

## 首次准备

在项目根目录执行：

```powershell
cd C:\Users\USER\Desktop\Dilee
npm ci
npx prisma generate --schema apps/api/prisma/schema.prisma
```

## 启动本地 PostgreSQL

终端一：

```powershell
cd C:\Users\USER\Desktop\Dilee
docker compose up -d postgres
docker compose ps
```

数据库连接参数：

```text
postgresql://dilee:dilee_local_dev@localhost:5432/dilee_erp?schema=public
```

首次启动或数据库结构有更新时执行：

```powershell
$env:DATABASE_URL='postgresql://dilee:dilee_local_dev@localhost:5432/dilee_erp?schema=public'
npx prisma migrate deploy --schema apps/api/prisma/schema.prisma

$env:INITIAL_ADMIN_USERNAME='admin'
$env:INITIAL_ADMIN_PASSWORD='DileeAdmin2026'
$env:INITIAL_ADMIN_DISPLAY_NAME='迪礼管理员'
npm run db:seed --workspace=@dilee/api
```

## 启动后端 API

终端二：

```powershell
cd C:\Users\USER\Desktop\Dilee
$env:DATABASE_URL='postgresql://dilee:dilee_local_dev@localhost:5432/dilee_erp?schema=public'
$env:PORT='3001'
npm run dev --workspace=@dilee/api
```

后端地址：`http://localhost:3001`

健康检查：

```powershell
Invoke-WebRequest http://localhost:3001/api/v1/health
```

## 启动前端 Web

终端三：

```powershell
cd C:\Users\USER\Desktop\Dilee
$env:API_INTERNAL_URL='http://localhost:3001'
npm run dev --workspace=@dilee/web
```

前端地址：`http://localhost:3000`

登录：

```text
用户名：admin
密码：DileeAdmin2026
```

前端通过 Next.js rewrite 将 `/api/v1/*` 转发到后端 `localhost:3001`，浏览器只需要访问 `3000`。

## 停止服务

分别在 API 和 Web 终端按 `Ctrl+C`，然后执行：

```powershell
docker compose down
```

`docker compose down` 不会删除数据库卷。不要在测试数据仍需保留时使用 `docker compose down -v`。

## 端口被占用时

```powershell
Get-NetTCPConnection -LocalPort 3000,3001,5432 -State Listen -ErrorAction SilentlyContinue
```

确认是旧的 Node/Next 进程后结束它：

```powershell
Stop-Process -Id <PID>
```

API 必须先启动，前端再启动，否则前端会出现 `ECONNREFUSED`。

## 一键检查

```powershell
Invoke-WebRequest http://localhost:3001/api/v1/health
Invoke-WebRequest http://localhost:3000
```

两个请求都成功后，再进行浏览器验收。
