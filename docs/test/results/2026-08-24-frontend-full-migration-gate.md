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

## 运行时 smoke

- Docker 中 `dilee-api-1` 与 `dilee-postgres-1` 健康运行。
- 临时前端 `http://localhost:3010` 的 `/`、`/login`、`/sales`、`/procurement`、`/warehouse`、`/production`、`/hr`、`/finance`、`/reports` 路由均返回 200。
- Playwright CLI 登录页可见用户名、密码和登录按钮；使用初始管理员登录后，生产和财务页面无控制台错误。
- 生产页面首次 smoke 暴露外加工接口路径不一致，已在 `ee5c6a0` 修正并复验无控制台错误。

完整业务写入、冲销和窄屏视觉验收仍需在正式验收窗口逐模块执行；本文件不将路由 smoke 视为完整业务验收。
