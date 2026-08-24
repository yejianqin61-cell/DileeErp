# 前端全量组件迁移静态门禁

日期：2026-08-24

## 已执行检查

- `npm run typecheck --workspace=@dilee/web`：通过。
- `npm run build --workspace=@dilee/web`：通过。
- `git diff --check`：通过。
- `rg "window\\.(prompt|alert|confirm)" apps/web`：无结果。
- 业务页面原生控件扫描：未发现直接使用的原生 `<select>`、`<textarea>`、`<table>`；登录页面保留语义化 `<form>`，仓库详情保留文件上传控件，统一组件实现内部保留原生元素。

## 本批提交

- `9cfd473` `refactor(web): migrate warehouse workspace`
- `c767ced` `refactor(web): migrate sales and customer workspace`
- `667e11d` `refactor(web): migrate procurement workspace`
- `ba9da6b` `refactor(web): migrate hr workspace`
- `1b67cf4` `refactor(web): migrate finance workspace`
- `e0e5e9d` `refactor(web): migrate workbench reports and login`
- `5e28146` `refactor(web): remove native business controls`

## 未在本机完成

真实 API、数据库和 Playwright 浏览器流程验收未在本次静态门禁中执行。需要启动可用的 API 与 PostgreSQL 后，按销售、采购、仓库、生产、人事、财务、工作台、报表和登录主流程逐页验收，并记录运行时证据。
