// 全站统一的「创建人 / 最后修改人」两列（components/data/audit-columns.tsx）的真实渲染测试。
//
// 用户 2026-09-16 定的口径：**两列**（创建人 + 最后修改人）、时间**固定北京时间到分**、
// 姓名取不到显示 `—` 而**绝不是 UUID**。
//
// 本文件钉住三条最容易在铺开时走样的约定：
//   1. 列名就是「创建人」「最后修改人」（各页不许自己起名）；
//   2. 姓名 + 时间同格两行（财务/生产的表本来就很宽，不能再横向滚动）；
//   3. 三种来源字段命名（created_by_name / createdAt / created_at）都能认——
//      现有接口里这三种同时存在，认不出就会静默显示空。
//
// 夹具的年份取自**北京时间当年**：`formatBeijingShort` 同年省略年份是业务口径，
// 若夹具写死 2026，测试在 2027 年跑就会因为「跨年」而变红。格式规则本身在
// lib/audit-time.test.mjs 里用注入的 now 单独测。
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { DataTable } from "../components/data/data-table";
import { auditColumns, auditDetailFields, type AuditRow } from "../components/data/audit-columns";
import { formatBeijing } from "../lib/audit-time";

const beijingYear = formatBeijing(new Date()).slice(0, 4);
const at = (monthDay: string, time: string) => `${beijingYear}-${monthDay}T${time}:00Z`;

type Row = AuditRow & { no: string };

const rows: Row[] = [
  // 服务端 join 出来的 snake_case 姓名 + Prisma 整行透传的 camelCase 时间
  { no: "PO-1", created_by_name: "张三", updated_by_name: "李四", createdAt: at("09-16", "00:30"), updatedAt: at("09-16", "06:05") },
  // 报表类接口手工挑过的 snake_case 时间；最后修改人取不到。created_at 落在北京午夜，
  // 用来钉住「午夜是 00:00 不是 24:00」；两个时间故意不同，避免同一格里出现两个一样的文本。
  { no: "PO-2", created_by_name: "王五", updated_by_name: null, created_at: at("09-15", "16:00"), updated_at: at("09-17", "02:15") },
  // 历史行：用户已删除 → 两个姓名都取不到
  { no: "PO-3", created_by_name: null, updated_by_name: null }
];

/** 渲染一张表并返回每行的查询作用域（DataTable 的行带 data-testid="data-table-row"）。 */
function renderRows(data: Row[] = rows) {
  render(<DataTable columns={[{ accessorKey: "no", header: "采购单号" }, ...auditColumns<Row>()]} data={data} />);
  return screen.getAllByTestId("data-table-row").map((row) => within(row));
}

describe("auditColumns：全站统一的创建人 / 最后修改人两列", () => {
  it("列名固定为「创建人」「最后修改人」，且两列都在业务列之后", () => {
    render(<DataTable columns={[{ accessorKey: "no", header: "采购单号" }, ...auditColumns<Row>()]} data={rows} />);
    expect(screen.getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual(["采购单号", "创建人", "最后修改人"]);
  });

  it("单元格 = 姓名 + 次行北京时间", () => {
    const [first, second] = renderRows();
    expect(first.getByText("张三")).toBeVisible();
    expect(first.getByText("09-16 08:30")).toBeVisible();
    expect(first.getByText("李四")).toBeVisible();
    expect(first.getByText("09-16 14:05")).toBeVisible();
    // 同一格里姓名与时间都在（两行结构），不是一个纯文本拼接
    expect(second.getByText("王五")).toBeVisible();
    expect(second.getByText("09-16 00:00")).toBeVisible(); // 午夜必须是 00:00，不能是 24:00
  });

  it("姓名取不到时显示 —，绝不显示 UUID", () => {
    const [, second, third] = renderRows();
    expect(second.getAllByText("—")).toHaveLength(1); // 最后修改人缺失
    expect(third.getAllByText("—")).toHaveLength(2); // 两人都取不到
    expect(third.queryByText(/[0-9a-f]{8}-[0-9a-f]{4}/i)).toBeNull();
    expect(third.queryByText("null")).toBeNull();
  });

  it("时间缺失时只显示姓名，不留一个空的时间行", () => {
    const [first] = renderRows([{ no: "R-1", created_by_name: "赵六", updated_by_name: "钱七" }]);
    const cells = first.getAllByText(/赵六|钱七/);
    expect(cells).toHaveLength(2);
    for (const cell of cells) expect(cell.closest(".audit-actor-cell")?.querySelector(".audit-actor-time")).toBeNull();
  });

  it("三种来源字段命名都认（否则报表类接口会静默显示空）", () => {
    const [first] = renderRows([{ no: "R-1", created_by_name: "赵六", updated_by_name: "赵六", created_at: at("09-16", "00:30"), updated_at: at("09-16", "06:05") }]);
    expect(first.getByText("09-16 08:30")).toBeVisible();
    expect(first.getByText("09-16 14:05")).toBeVisible();
  });

  it("详情区用四行具名字段，不挤成一格", () => {
    expect(auditDetailFields(rows[0])).toEqual([
      { label: "创建人", value: "张三" },
      { label: "创建时间", value: "09-16 08:30" },
      { label: "最后修改人", value: "李四" },
      { label: "最后修改时间", value: "09-16 14:05" }
    ]);
  });

  it("详情区：都没有时给 —，不留空字符串", () => {
    expect(auditDetailFields({ created_by_name: null, updated_by_name: null })).toEqual([
      { label: "创建人", value: "—" },
      { label: "创建时间", value: "—" },
      { label: "最后修改人", value: "—" },
      { label: "最后修改时间", value: "—" }
    ]);
  });
});
