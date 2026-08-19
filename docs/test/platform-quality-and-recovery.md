# 平台质量与恢复记录

## 自动化检查

运行 `npm test` 会构建 API 并执行平台公共契约单元测试：

- 成功 JSON 信封和分页元数据。
- 审计字段只从服务端当前用户写入。

在未连接 PostgreSQL 的开发环境，人工 smoke 验证命令为 `npm run build --workspace=@dilee/api` 后访问 `GET /api/v1/health`，以及 `GET /api/v1/auth/me` 的 `401` 响应。

数据库依赖路径（登录持久化、模块授权、字典 CRUD、状态机、附件元数据）必须在 PostgreSQL 可用后追加集成测试。

## 厂内备份

每日任务在厂内服务器执行：

```powershell
.\scripts\backup-postgres.ps1 -DatabaseUrl $env:DATABASE_URL -BackupDirectory 'E:\DileeBackups'
```

备份目录必须是独立于应用服务器系统盘的厂内存储。脚本生成 custom-format dump 和 SHA-256 校验文件，不上传云端。

## 恢复演练

恢复只能针对明确的目标数据库执行。演练前停止应用并确认目标库：

```powershell
.\scripts\restore-postgres.ps1 -DatabaseUrl $env:DATABASE_URL -BackupFile 'E:\DileeBackups\dilee-erp-YYYYMMDD-HHMMSS.dump'
```

恢复后执行：数据库迁移状态检查、API 健康检查、管理员登录、字典读取和附件下载抽检。每次演练日期、备份文件哈希、执行人和结果记录在本目录新增记录文件。
