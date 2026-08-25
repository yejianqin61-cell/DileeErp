# 04 — 生产日报与员工日报组件迁移

**What to build:** 将工序日报、员工计件/计时日报、日报历史、超单和差异告警迁移到统一 Form、Select、Input、Textarea、DataTable 和 Sheet。

**Blocked by:** 03 — 生产主页面全量组件迁移

**Status:** ready-for-agent

- [ ] 工序日报和员工日报使用 React Hook Form 与统一字段组件
- [ ] 生产单、工序、员工使用业务选择器，不手填内部 ID
- [ ] 日报历史使用 DataTable，详情/服务端累计使用 Sheet
- [ ] 删除日报、确认告警使用 AlertDialog 并要求原因/备注
- [ ] 完成日报主流程、超单和差异错误场景浏览器验收

