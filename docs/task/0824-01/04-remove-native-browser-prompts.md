# 04 — 清除原生浏览器弹窗并统一业务操作流

**What to build:** 清除所有业务页面中的 `window.prompt`、`window.alert`、`window.confirm`，将数据录入、确认、冲销和更正迁移到统一 Dialog、Sheet 和 AlertDialog。

**Blocked by:** 02 — 建立表单、Dialog、Sheet 与反馈组件体系; 03 — 统一页面壳、筛选区与数据表模式

**Status:** ready-for-agent

- [ ] 全前端不再调用原生 prompt、alert、confirm
- [ ] 新增和编辑操作改为结构化表单
- [ ] 过账、关闭、冲销和软删除使用确认弹窗
- [ ] 冲销和更正操作要求填写原因并保留表单内容
- [ ] 错误信息显示在页面或表单内，不仅依赖 toast
- [ ] 完成全局搜索和浏览器回归，确认无原生弹窗残留

