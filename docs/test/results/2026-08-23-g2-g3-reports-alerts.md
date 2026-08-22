# G2/G3 报表、导出与告警中心测试记录

- 提交基线：`c627b7c`
- 测试日期：2026-08-23
- 范围：报表查询、Excel 兼容 CSV 导出、告警列表与告警处理、Web 页面

| 命令 | 结果 | 说明 |
| --- | --- | --- |
| `npm run test:unit` | 通过 | 60/60，通过 API 构建及领域/契约单元测试 |
| `npm run typecheck --workspace=@dilee/api` | 通过 | TypeScript 类型检查通过 |
| `npm run build --workspace=@dilee/api` | 通过 | NestJS 生产构建通过（由 `test:unit` 执行） |
| `npm run build --workspace=@dilee/web` | 通过 | Next.js 生产构建通过，`/reports` 页面已生成 |
| `npm run verify:chain` | 环境阻断 | 缺少真实测试数据库、API 服务和浏览器基址 |

## 环境阻断

以下变量未提供，因此未执行真实 PostgreSQL/API/Playwright 回归：

- `TEST_DATABASE_URL`
- `API_BASE_URL`
- `PLAYWRIGHT_BASE_URL`

`verify:chain` 已由仓库脚本以退出码 3 明确标记为 `TEST_BLOCKED`，不将其计为代码失败，也不将快速测试结果冒充现场验收。

## 结论

G2/G3 的代码、领域单元测试、类型检查和前后端构建完成。真实链路验收待提供专用测试数据库、运行中的 API/Web 服务和 Playwright 地址后补测。下一阶段进入 G4：厂内部署、备份恢复和并发性能验收。
