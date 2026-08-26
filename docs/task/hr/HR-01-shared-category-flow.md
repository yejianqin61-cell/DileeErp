# HR-01 统一新增类目返回链路

## 目标

让所有人事表单的“新增类目”都支持：保存当前输入、打开创建表单、创建成功后回到原表单、刷新下拉选项并自动选中新类目；失败或取消不清空原表单。

## 范围

- `apps/web/components/ui/action-dialog.tsx`
- `apps/web/app/hr/page.tsx` 的类目回调
- 必要的组件或页面测试

## 实现要求

- `onAddCategory` 支持 `Promise`，返回新建类目的 `{ id, label }` 或等价结果。
- 不得直接修改 `fields`、`defaultValue` 或 `options` 入参对象。
- 父页面保存原表单上下文：标题、字段值、当前创建字段和原业务记录 id。
- 创建成功后以不可变方式重建字段，合并新选项，写入新 id，再恢复原表单。
- `ActionDialog` 提交状态期间禁用关闭和重复提交；类目创建失败时保持原表单。

## 验收

- 用部门或员工创建流程验证普通字段值保留、创建字段自动选中。
- 取消创建不改变原表单。
- 创建接口失败时原表单和错误仍可见。
- 组件和 Web 类型检查通过。

## 提交

`fix(web): make category creation return to source forms`
