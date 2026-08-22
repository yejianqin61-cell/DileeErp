# 厂内部署运行手册

1. 复制 `.env.factory.example` 为 `.env.factory`，替换数据库密码和初始管理员密码；不要将该文件提交到 Git。
2. 检查编排：`npm run factory:config`。
3. 启动并构建：`npm run factory:up`。
4. 查看状态和日志：`docker compose -f docker-compose.factory.yml --env-file .env.factory ps`、`npm run factory:logs`。
5. 在厂内浏览器访问 `http://服务器地址:3000`，健康检查为 `http://服务器地址:3001/api/v1/health`。
6. 停止服务：`npm run factory:down`。升级前先执行备份，升级失败时固定镜像版本并回滚。

数据库端口只存在于 Compose 内部网络；备份目录必须位于独立厂内存储设备。

备份示例：`powershell -File scripts/backup-postgres.ps1 -DatabaseUrl $env:DATABASE_URL -BackupDirectory D:\DileeBackups`。
恢复前先执行 `powershell -File scripts/check-backup.ps1 -BackupFile D:\DileeBackups\dilee-erp-YYYYMMDD-HHMMSS.dump`，确认目标库后再执行 `powershell -File scripts/restore-postgres.ps1 -DatabaseUrl $env:RESTORE_DATABASE_URL -BackupFile ... -ConfirmTarget RESTORE`。

性能基线：设置 `PERF_BASE_URL` 后执行 `npm run perf:gate`；可用 `PERF_CONCURRENCY=3 PERF_REQUESTS=30` 调整样本。需要登录态的接口时通过 `PERF_COOKIE` 注入 Cookie。结果写入 `docs/test/results/latest-performance.json`。
