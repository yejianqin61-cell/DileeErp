# G4 厂内部署、备份恢复与并发性能验收记录

- 代码基线：`e598dd3`
- 测试日期：2026-08-23
- 范围：厂内 Compose 配置、生产构建、备份恢复脚本、并发性能门禁

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| `docker compose -f docker-compose.factory.yml --env-file .env.factory.example config --quiet` | 通过 | Compose 配置可解析 |
| API/Web 生产构建 | 通过 | API 和 Web build 均通过 |
| PowerShell 备份/恢复脚本解析 | 通过 | 3 个脚本解析无语法错误 |
| `npm run test:performance` | 通过 | 百分位计算测试 2/2 |
| `npm run perf:gate` | 环境阻断 | 未提供 `PERF_BASE_URL` |
| `npm run verify:quick` | 通过 | typecheck、unit、API/Web build 全部通过 |

## 尚未完成的现场验收

本机未提供可用的厂内 PostgreSQL、API/Web 运行地址和独立备份存储，因此尚未执行：

- Docker 镜像实际构建和服务器启动；
- Prisma migration、管理员 seed 和健康检查实测；
- PostgreSQL dump、哈希校验、清库恢复及恢复后业务抽检；
- 2-3 并发真实数据压测。

上述项目属于部署现场阻断，不将静态配置检查和离线测试写成生产验收通过。现场执行命令见 `docs/deployment/factory-runbook.md`。

## 结论

G4 的可交付脚本、Compose 基线、运行手册和质量门禁已完成。正式上线前必须在厂内服务器补做真实部署、恢复演练和性能记录；后续开发链路进入 G5 历史数据迁移与上线核对。
