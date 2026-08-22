# E1 成品送检与成品 QC 测试记录

## 已通过的快速门禁

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| API 类型检查 | 通过 | `npm run typecheck --workspace=@dilee/api` |
| Web 类型检查 | 通过 | `npm run typecheck --workspace=@dilee/web` |
| API 构建 | 通过 | `npm run build --workspace=@dilee/api` |
| Web 构建 | 通过 | `npm run build --workspace=@dilee/web` |
| 单元测试 | 35/35 通过 | `npm run test:unit` |
| 差异检查 | 通过 | `git diff --check` |

## 已覆盖行为

- Decimal QC 数量守恒及合格、条件接收、不合格、混合结论推导。
- QC 可入库来源为合格与条件接收数量，且不直接创建库存事实。
- 厂内完工和外加工回厂待 QC 来源的送检、提交、取消与累计数量门禁。
- 分批 QC、可入库来源查询、影响预览和更正记录 API。
- 外加工回厂 QC 状态和 D7 QC 汇总联动。
- Web 仓库工作台的真实来源加载、送检、提交和 QC 录入。

## 后置验证

| 检查 | 状态 | 阻断原因 |
| --- | --- | --- |
| PostgreSQL 集成测试 | 未运行 | `TEST_DATABASE_URL` 未配置 |
| HTTP API 测试 | 未运行 | `API_BASE_URL` 未配置 |
| Playwright 浏览器测试 | 未运行 | `PLAYWRIGHT_BASE_URL` 未配置 |

真实环境具备后执行 `npm run verify:chain`，至少验证两类来源、分批与并发超量、无库存副作用、QC 更正风险、RBAC、审计和 E1 -> E2 可入库来源。上述后置项目未完成前，E1 标记为“代码/单元/构建完成”，不宣称真实链路关闭。
