# 12 — 全站原生控件清理与旧实现收敛

**What to build:** 对全站业务页面执行静态清理，移除直接使用的原生表单、表格、旧面板和重复样式实现。

**Blocked by:** 03 — 生产主页面全量组件迁移; 04 — 生产日报与员工日报组件迁移; 05 — 外加工交接与成品 QC 组件迁移; 06 — 仓库全量组件迁移; 07 — 销售与客户全量组件迁移; 08 — 采购全量组件迁移; 09 — 人事全量组件迁移; 10 — 财务全量组件迁移; 11 — 工作台、报表与登录组件迁移

**Status:** ready-for-agent

- [ ] 业务页面扫描不到直接的 input/select/textarea/form/table
- [ ] 业务页面扫描不到 window.prompt/alert/confirm
- [ ] 旧面板、占位组件和重复 CSS 已删除或明确保留理由
- [ ] 所有列表均通过 DataTable/Table 原语渲染
- [ ] 所有业务输入均通过 Form/Dialog/Sheet 承载

