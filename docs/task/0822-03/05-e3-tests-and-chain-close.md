# Task 05：E3 测试、质量门禁与链路关闭

## 目标

验证 E3 关键业务不变量并形成测试记录。

## 实施要求

- 覆盖分批出库、超发原因、负库存拒绝、重复过账、发货/签收日期、客户退货两种去向、冲销恢复和权限。
- 运行 API 类型检查、构建、单元测试；环境具备时运行 PostgreSQL/API/浏览器回归。
- 写入 `docs/test/results/2026-08-22-e3-finished-goods-outbound.md`。
- 更新 `docs/task/coding-roadmap-todolist.md` 的 E3 状态和下一步建议。

## 完成标准

自动化检查通过，后置环境验证如未执行必须明确记录。
