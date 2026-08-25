# 前端组件采用情况审计（2026-08-24）

## 结论

当前项目已经建立 shadcn/ui 风格组件基础层，但尚未完成全站迁移。不能把“组件文件存在”视为“全站页面已使用”。

## 组件层现状

已建立：

- `Button`、`Badge`、`Card`、`Label`、`Separator`
- `Input`、`Textarea`、`Select`
- `Dialog`、`AlertDialog`、`Sheet`
- `Form`、`Table`、`Toast`
- `ActionDialog`

已配置 Radix primitives 和 `components.json`。

## 页面采用情况

| 页面/区域 | 已使用新组件 | 仍存在原生/旧实现 | 结论 |
| --- | --- | --- | --- |
| 销售 | Button、Input、ActionDialog、Sheet | 原生 table | 部分迁移 |
| 采购 | Button、Input、ActionDialog、Sheet | 原生 table | 部分迁移 |
| 仓库 | Button | 原生 form/input/select/textarea/table | 未完成 |
| 生产主页面 | Button | 原生 form/input/select/table；基础资料和生产单仍内嵌表单 | 未完成 |
| 生产日报 | Button、React Hook Form | 原生 form/input/select/textarea/table | 未完成 |
| 外加工交接 | Button、React Hook Form | 原生 form/input/select/textarea/table | 未完成 |
| 成品 QC | Button、React Hook Form | 原生 form/input/select/textarea/table | 未完成 |
| 人事 | Button、ActionDialog | 原生 table | 部分迁移 |
| 财务 | Button、ActionDialog | 原生 table | 部分迁移 |
| 报表与告警 | Button、ActionDialog | 原生 input/table | 部分迁移 |
| 登录 | Button | 原生 input/form | 未完成 |
| 工作台 | Button | 依赖子组件的旧表格/面板 | 未完成 |

## 关键发现

1. 生产页面没有真正使用新的 `Dialog`、`Sheet`、`Select`、`Input`、`Form`、`Table` 组件。
2. 生产日报、外加工交接、成品 QC 是当前原生控件最密集的区域。
3. 财务、人事、报表虽然录入动作已迁移到 `ActionDialog`，但列表仍使用手写 `<table>`，没有使用统一 `DataTable`/`Table` 原语。
4. `AlertDialog`、`Toast`、`Form`、`Select`、`Textarea`、`DataTable` 在业务页面中的实际采用率仍很低。
5. 当前“无原生 prompt/alert/confirm”只代表浏览器阻塞式弹窗已清除，不代表全站表单控件已完成治理。

## 后续整改顺序

1. 生产主页面：基础资料、生产单全部改为 Dialog，生产单详情改为 Sheet。
2. 生产日报、外加工交接、成品 QC：原生表单改为统一 Form + Input/Select/Textarea，历史记录改为 DataTable。
3. 仓库：领料、退料、报废、冲销和成品 QC 详情改为 Dialog/Sheet，表格改为 DataTable。
4. 人事、财务、报表：将现有原生 table 替换为 DataTable/Table，补充行详情 Sheet。
5. 登录和工作台：纳入基础组件和反馈状态回归。

## 验收口径

- 业务页面不得直接出现 `<input>`、`<select>`、`<textarea>`、`<table>`，除非是组件实现内部。
- 业务页面表单必须使用统一 Form 或 ActionDialog，并具备字段校验和错误反馈。
- 业务页面列表必须使用 DataTable 或 Table 原语。
- 复杂详情必须使用 Sheet；高影响动作必须使用 AlertDialog。
- 通过全站静态扫描、类型检查、生产构建和浏览器验收后，才可宣称前端治理完成。
