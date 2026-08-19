# 前端初始化验收记录

## 自动验证

- `npm run typecheck --workspace=@dilee/web`：通过。
- `npm run build --workspace=@dilee/web`：通过。
- 初始路由已由 Next.js 构建产物收集：`/`、`/production`、`/procurement`、`/finance`、`/warehouse`、`/hr`、`/customers`。

## 人工验收

浏览器页面由项目负责人自行验收。验收重点：桌面布局、导航激活状态、工作台三类视角、六模块占位页、演示数据提示、空/加载/错误状态和中文文案。

## 范围说明

本阶段页面使用演示 adapter，不连接真实业务 API，不写入业务数据库；页面中的字段和操作仍需模块负责人访谈确认。
