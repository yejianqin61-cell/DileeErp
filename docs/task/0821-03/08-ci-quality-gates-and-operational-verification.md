# 0821-03-08 CI 质量门禁与部署前测试验收

## 状态

已完成（链路环境待接通）

## 认领

负责人：Codex
开始日期：2026-08-21

## 目标

把快速测试、链路测试、报告归档和部署前检查接入统一质量门禁，确保后续每个业务任务不会跳过测试。

## 关联决策

- `docs/design/testing-system-and-tooling-plan.md` 第 9 至 12 节
- `docs/test/platform-quality-and-recovery.md`
- `.agent/constitution/constitution.md`

## 范围

- 配置提交前快速门禁：typecheck、unit、API build、Web build；
- 配置链路门禁：测试库准备、integration、API、E2E、`verify:chain`；
- 归档 JUnit/JSON/Markdown 结果，脱敏密码、Cookie、结算和真实业务数据；
- 在 CI/本地报告中区分代码失败、业务断言失败和环境阻断；
- 增加备份恢复、迁移状态、健康检查、管理员登录和附件抽检的部署前测试清单；
- 规定后续每个业务 task 必须链接测试用例和结果，未通过不得标记完成。

## 非范围

- CI 厂商选择和云端部署；
- 正式生产服务器配置；
- 大规模压测、混沌测试和移动端。

## 验收与验证

1. 快速门禁不依赖 PostgreSQL，链路门禁在数据库不可用时明确阻断。
2. 任一测试失败会使对应质量门禁失败，不允许脚本吞错或自动降级。
3. 结果包含提交号、命令、环境、通过/失败数量、阻断原因和遗留风险。
4. 备份恢复演练能验证迁移、健康、登录、字典和附件基本可用。
5. 方案完成后更新测试体系文档、测试 README、每日开发日志和后续任务模板约定。

## 决策记录

覆盖率只作为趋势信息，不作为唯一质量指标；真实数据流、错误路径和可追溯性优先。

## 完成记录

负责人：Codex
完成日期：2026-08-21
验证：`npm run verify:quick` 已通过 typecheck、14 项 unit tests、API build 与 Web build。`npm run verify:chain` 生成报告并如实标记测试库、API 和浏览器地址缺失导致的环境阻断；门禁实现不吞错、不降级。
