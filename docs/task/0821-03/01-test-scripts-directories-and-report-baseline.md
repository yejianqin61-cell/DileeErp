# 0821-03-01 测试脚本、目录与报告基线

## 状态

待认领

## 认领

负责人：
开始日期：

## 目标

建立统一测试目录、脚本命名和结果格式，让开发者能区分快速测试、API 测试、集成测试和 E2E 测试。

## 关联决策

- `docs/design/testing-system-and-tooling-plan.md` 第 3、4、9 节
- `docs/test/README.md`
- `package.json`、`apps/api/package.json`、`apps/web/package.json`

## 范围

- 建立 `apps/api/test/unit`、`apps/api/test/http`、`apps/api/test/integration`、`tests/e2e`、`tests/fixtures`、`tests/helpers`、`docs/test/cases`、`docs/test/results` 目录约定；
- 增加 `test:unit`、`test:api`、`test:integration`、`test:e2e`、`verify:chain` 脚本入口；
- 统一测试退出码、环境变量命名、测试名称和 JSON/JUnit/Markdown 结果输出约定；
- 保留现有 Node 原生测试，不强制快速 `test` 依赖 PostgreSQL 或浏览器。

## 非范围

- 具体业务链路用例实现；
- Playwright 浏览器安装和真实数据库夹具；
- 覆盖率阈值和 CI 平台配置。

## 验收与验证

1. 本地可分别运行快速单元测试和各专项脚本，缺少数据库时专项脚本返回明确环境阻断。
2. 测试结果包含提交号、命令、环境、通过/失败数量和阻断原因。
3. 现有 `npm test` 行为不被破坏，API 测试仍可运行。
4. 脚本文档和目录 README 与方案一致，`git diff --check` 通过。

## 决策记录

采用 Node 原生测试作为快速层，避免为基础规则引入新的测试框架；高层测试工具按专项任务引入。

## 完成记录

负责人：
完成日期：
验证：
