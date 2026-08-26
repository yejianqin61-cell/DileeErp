# 01 - 唯一可编辑 BOM 表 API

**What to build:** 已确认销售单只能创建一份 BOM 表。采购模块可以读取并编辑该表的物料名称、型号、颜色、数量和单位；重复创建被服务端拒绝，已创建的 BOM 表可以在受保护的状态下修改。

**Blocked by:** None - can start immediately.

**Status:** ready-for-agent

- [ ] 同一销售单的第二份 BOM 表返回稳定的冲突错误。
- [ ] BOM 行保存名称、型号、颜色、数量和单位，且 API 返回这些字段。
- [ ] 单元测试覆盖唯一性、编辑与行校验。

