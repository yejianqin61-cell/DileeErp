# 生产进度表去掉「当日合计」列 + 全站 XLSX 数字单元格改为数值类型

- 日期：2026-09-14（第三轮）
- 状态：已实施
- 范围：`apps/api/src/modules/production/production-payroll-export.service.ts` 及对应单测
- 需求来源：用户 2026-09-14 直接指令

## 1. 去掉「当日合计」列

生产进度表（`exportProductionProgress`，原「材料与车间生产对应表」的下表）此前的版式是：

```
日期 | 工序A | 工序B | … | 当日合计
目标数量 | … | —
加工地点 | … | —
2026-09-01 | … | 当日合计
…
合计 | … | 全部合计
```

用户要求去掉最后一列「当日合计」。理由（与业务一致）：

1. 横排各工序相加**没有业务含义**——同一件产品会经过多道工序，把不同工序的完成数量加在一起会重复计数；
2. 它让 A4 版面多占一列（版式本来就是为「落进一页 A4」调过的）。

改动：删除 `progressHeader` 的 `"当日合计"`、`targetRow`/`locationRow` 尾部的占位列、每日行的 `dayTotal`、合计行的 `grandTotal`。
**表尾仍按工序给出累计量**（每个工序列的合计保留），读者需要横向汇总时可以用 Excel 自行求和。

没有日报时仍然输出表头 + 两行标注 + 合计行（合计为 0），不改变「能确定确实是 0 而不是漏行」的既有性质。

## 2. 数字单元格必须是数值类型

### 问题

`production-payroll-export.service.ts` 用 SheetJS（`xlsx`）的 `aoa_to_sheet` 生成工作簿，
所有数量、单价、金额、时长都写成 `Prisma.Decimal.toString()` —— 即**文本型数字**。
在 Excel 里文本型数字表现为「数字存储为文本」：`SUM` 得 0、筛选分不出数值区间、
排序按字典序（`"100" < "20"`）、条件格式与图表都不认。

### 改动

新增私有工具：

```ts
/** 数值单元格：必须落成 Excel 的数字类型；空值返回 null（空单元格）而不是 ""（那同样是一格文本）。 */
private num(value: Prisma.Decimal | string | number | null | undefined): number | null
private hours(durationMinutes: Prisma.Decimal | null): number | null   // 由返回字符串改为返回数字
```

覆盖全部四张表的数值列：

| 表 | 数值列 |
| --- | --- |
| 工序盘点表 | 明细的计件数量 / 时长（小时）/ 单价 / 合计；汇总的件数合计、其中计件、其中计时、时长合计、合计 |
| 当月工序明细总表 | 同上（按工序汇总） |
| 订单号盘点表 | 明细同上；表头的计划数量、汇总数量 |
| 原料对应表 | 订单数量、单价、数量 |
| 生产进度表 | 目标数量、各工序每日完成数量、各工序累计、出货数量 |

### 明确不做

- **日期列仍写成 `YYYY-MM-DD` 字符串**：ISO 日期按字典序排序与按时间排序一致，Excel 也能正确识别为日期做筛选，
  改成真日期单元格会改变工作簿的读取语义（`sheet_to_json` 会返回 `Date` 对象），收益不抵回归风险；
- **页面表格不改**：用户确认本次只针对导出的 Excel。页面 `DataTable` 目前不启用排序，
  数字展示一律是「后端原值 + 币种」的字符串拼接，属于另一件事（若要做需要给 DataTable 加排序/列对齐能力）。
- 采购订单导出（`purchase-order-export.service.ts`）与领料单导出（`material-slip-export.service.ts`）用的是 ExcelJS，
  本来就写入 `number` 并设置了 `numFmt`，无需改动；报表模块导出的是 CSV，CSV 没有单元格类型。

## 3. 验证

- `npm run typecheck --workspace=@dilee/api`：通过。
- `npm run test:unit:api`：**908 / 908 通过**。相关断言改动与新增：
  - `apps/api/test/unit/material-production-export-layout.test.cjs`：表头不再含「当日合计」、合计行不再有全部合计列；
    新增用例断言目标数量行、日期行、合计行、出货数量的单元格类型是 `n`（数值），并做全表扫描
    「不允许存在看起来是数字却写成文本的单元格」；
  - `apps/api/test/production-payroll-export-hours.test.cjs`：读取改为断言数字（`1.5` 而不是 `"1.5"`），
    新增两条数值单元格类型断言（工序盘点表、当月工序明细总表、订单号盘点表）。
- 未执行：真实 Excel 打开验证（无 GUI 环境），以及 `apps/api/test/http` / `test:integration`（本机无 PostgreSQL）。

## 4. 未决事项

1. 生产进度表的「出货数量」仍放在表头上方元信息行；是否要为它单独加一行「已出货 / 未出货」由业务确认；
2. 导出表的数字格式（小数位数、千分位）目前沿用 Excel 默认 `General`，是否要显式 `numFmt`（如 `#,##0.00##`）由业务确认。
