# 阶段一 R-4 专用只读数据库身份

日期：2026-11-02｜状态：完成｜输出：Markdown

本批次补齐 `dilee_phase1_test` 的实际数据库身份边界。目标是让宿主的受限读取通道只能以专用只读角色连接测试库。

| 顺序 | 任务 | 交付 |
| --- | --- | --- |
| 1 | [配置专用只读角色](task-1-provision-readonly-role.md) | 数据库角色和最小授权 |
| 2 | [锁定 adapter 身份](task-2-pin-adapter-identity.md) | 固定角色的宿主命令 |
| 3 | [验证真实权限边界](task-3-verify-readonly-boundary.md) | 实库读与写拒绝证据 |

结果：`dilee_phase1_reader` 能读取日报表；PostgreSQL 拒绝其 `INSERT`。

