// DataTable 的「超长省略 + 悬停看全文」契约（components/data/data-table.tsx）。
//
// 为什么单独测这一层：`meta.ellipsis` 是**全站**十来张宽表共用的开关，而它依赖的 title 有两层来源。
// 2026-10-08 之前只有第一层（渲染结果必须是字符串），于是最普通的列写法 —— 只写 `accessorKey` ——
// 省略号照常出现、鼠标悬停却什么都没有：TanStack 给没写 `cell` 的列用的是默认 cell（一个函数），
// `flexRender` 见到函数就 `createElement`，`typeof rendered === "string"` 永不成立。
// 这种"哑掉"没有任何迹象（页面只是不显示 tooltip），所以必须由测试钉住。
//
// 第二层（这一格的值）是物料清单页触发的：用户 2026-10-08「表格所有列宽限定长度，超过就省略显示，
// 鼠标hover才显示所有文字」—— 物料编码 / 物料名称两列正是 `accessorKey` 写法。
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { ColumnDef } from "@tanstack/react-table";
import { DataTable } from "../components/data/data-table";

type Row = { no: string; name: string; quantity: number; spec?: string | null; note?: string | null };

const rows: Row[] = [{ no: "SO-2026-0001", name: "加厚双面哑光涤纶织带（红蓝撞色定制款）烫金logo工艺", quantity: 1200, spec: null, note: null }];

/** 渲染一张五列的表（四种取 title 的路径各一列），返回「按列名取单元格」的函数。 */
function renderTable(ellipsisColumns: string[]) {
  const meta = (id: string) => (ellipsisColumns.includes(id) ? { width: "20%", ellipsis: true } : { width: "20%" });
  const columns: ColumnDef<Row>[] = [
    { accessorKey: "no", header: "单号", meta: meta("no") },
    { accessorKey: "name", header: "名称", meta: meta("name") },
    { accessorKey: "quantity", header: "数量", meta: meta("quantity") },
    // 翻译过的列：值是「无」，屏幕上也显示「无」（accessorFn 写法 → 有值可回退）
    { id: "spec", header: "规格", meta: meta("spec"), accessorFn: (row) => row.spec ?? "无" },
    // 没有 accessor 的纯自定义 cell 列（屏幕上有字，但表拿不到"值"）
    { id: "note", header: "备注", meta: meta("note"), cell: ({ row }) => row.original.note ?? "无备注" },
    // 按钮（ReactNode）
    { id: "action", header: "操作", meta: meta("action"), cell: () => <button type="button">编辑</button> },
  ];
  render(<DataTable columns={columns} data={rows} />);
  const headers = screen.getAllByRole("columnheader").map((cell) => cell.textContent ?? "");
  const cells = screen.getAllByRole("cell");
  return (header: string) => cells[headers.indexOf(header)];
}

describe("DataTable：cell-ellipsis 与悬停 title", () => {
  it("只写 accessorKey 的文本列也有 title（TanStack 默认 cell 返回元素，第一层取不到）", () => {
    const cell = renderTable(["no", "name"]);
    expect(cell("单号")).toHaveClass("cell-ellipsis");
    expect(cell("单号")).toHaveAttribute("title", "SO-2026-0001");
    expect(cell("名称")).toHaveAttribute("title", "加厚双面哑光涤纶织带（红蓝撞色定制款）烫金logo工艺");
  });

  it("数字也能当 title（数量列），转成字符串而不是去掉", () => {
    const cell = renderTable(["quantity"]);
    expect(cell("数量")).toHaveAttribute("title", "1200");
  });

  it("值被翻译过的列：title 是屏幕上那串字，不是原始值", () => {
    const cell = renderTable(["spec"]);
    // spec 的值是 null、accessorFn 把它变成屏幕上的「无」
    expect(cell("规格")).toHaveTextContent("无");
    expect(cell("规格")).toHaveAttribute("title", "无");
  });

  it("没有 accessor 的纯自定义 cell 列拿不到 title —— 这是契约，要 title 就写成 accessorFn", () => {
    // 这条不是"漏了"：DataTable 只能从**值**里取全文，`id` + 自定义 cell 的列没有值。
    // 物料清单页的「默认单位」因此改成了 accessorFn（见 app/procurement/materials/page.tsx）。
    const cell = renderTable(["note"]);
    expect(cell("备注")).toHaveTextContent("无备注");
    expect(cell("备注")).not.toHaveAttribute("title");
  });

  it("按钮那类 ReactNode 列：不给 title（拼一句按钮文案比没有更让人困惑）", () => {
    const cell = renderTable(["action"]);
    expect(cell("操作")).not.toHaveAttribute("title");
  });

  it("没开 ellipsis 的列：不带 cell-ellipsis，也不带 title", () => {
    const cell = renderTable([]);
    for (const header of ["单号", "名称", "数量", "规格"]) {
      expect(cell(header)).not.toHaveClass("cell-ellipsis");
      expect(cell(header)).not.toHaveAttribute("title");
    }
  });
});
