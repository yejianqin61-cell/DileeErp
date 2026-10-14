// DataTable 的「超长省略 + 悬停看全文 + 默认固定列宽」契约（components/data/data-table.tsx）。
//
// 为什么单独测这一层：这套行为是**全站**表格的默认值，而它依赖的 title 有两层来源。
// 2026-10-08 之前只有第一层（渲染结果必须是字符串），于是最普通的列写法 —— 只写 `accessorKey` ——
// 省略号照常出现、鼠标悬停却什么都没有：TanStack 给没写 `cell` 的列用的是默认 cell（一个函数），
// `flexRender` 见到函数就 `createElement` —— `typeof rendered === "string"` 永不成立。
// 这种"哑掉"没有任何迹象（页面只是不显示 tooltip），所以必须由测试钉住。
//
// 第二层（这一格的值）是物料清单页触发的：用户 2026-10-08「表格所有列宽限定长度，超过就省略显示，
// 鼠标hover才显示所有文字」—— 物料编码 / 物料名称两列正是 `accessorKey` 写法。
//
// 2026-10-09 又一次口径变化，用户原话：「针对本项目所有的表格…我希望每个 column 都能限定宽度。
// 超过字数就省略显示。鼠标hover的时候再显示全部文字。」——
//   · `title` / `cell-ellipsis` 从「逐列写 `meta.ellipsis: true` 才有」改成**默认就有**，
//     只有 `meta.ellipsis: false` 才关掉；
//   · `<table>` 从「有列给了 `meta.width` 才切固定布局」改成**一律 `data-table-fixed`**
//     （固定布局下没给宽度的列由浏览器均分容器宽度 —— 「每个 column 都有上界」成为默认值）。
// 旧契约的测试（「没开 ellipsis 的列不带 cell-ellipsis / 不带 title」）随之作废，
// 换成下面这组新契约。全站盘点见 docs/design/table-column-width-audit-2026-10-09.md。
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ColumnDef } from "@tanstack/react-table";
import { DataTable } from "../components/data/data-table";

type Row = { no: string; name: string; quantity: number; spec?: string | null; note?: string | null };
type Meta = { width: string; ellipsis?: boolean };

const rows: Row[] = [{ no: "SO-2026-0001", name: "加厚双面哑光涤纶织带（红蓝撞色定制款）烫金logo工艺", quantity: 1200, spec: null, note: null }];

/**
 * 渲染一张六列的表（四种取 title 的路径各一列），返回「按列名取单元格 / 取表头」的函数。
 *
 * `meta` 是逐列 meta 的构造器 —— 老写法传 `{ width, ellipsis: true }`，新默认只传 `{ width }`。
 */
function renderTable(meta: (id: string) => Meta) {
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
  const headers = screen.getAllByRole("columnheader");
  const headerNames = headers.map((cell) => cell.textContent ?? "");
  const cells = screen.getAllByRole("cell");
  return {
    head: (header: string) => headers[headerNames.indexOf(header)],
    cell: (header: string) => cells[headerNames.indexOf(header)],
  };
}

/** 2026-10-09 起的默认写法：只给宽度，**不写** `ellipsis`（这就是「要省略 + hover 全文」）。 */
const defaultMeta = (): Meta => ({ width: "20%" });
/** 旧写法：显式写 `ellipsis: true`（仍然有效，只是不再是必须的）。 */
const explicitOn = (): Meta => ({ width: "20%", ellipsis: true });

describe("DataTable：默认固定列宽 + 默认省略 + 默认悬停 title", () => {
  it("表一律切固定布局（2026-10-09 起不再需要某一列给 meta.width 才切）", () => {
    const { cell } = renderTable(defaultMeta);
    const table = cell("单号").closest("table");
    expect(table).not.toBeNull();
    expect(table!.classList.contains("data-table-fixed")).toBe(true);
  });

  it("不写 ellipsis 的文本列：默认就带 cell-ellipsis + title", () => {
    const { cell } = renderTable(defaultMeta);
    expect(cell("单号")).toHaveClass("cell-ellipsis");
    expect(cell("单号")).toHaveAttribute("title", "SO-2026-0001");
    expect(cell("名称")).toHaveClass("cell-ellipsis");
    expect(cell("名称")).toHaveAttribute("title", "加厚双面哑光涤纶织带（红蓝撞色定制款）烫金logo工艺");
  });

  it("显式写 ellipsis: true 的老写法仍然有效（向后兼容）", () => {
    const { cell } = renderTable(explicitOn);
    expect(cell("单号")).toHaveClass("cell-ellipsis");
    expect(cell("单号")).toHaveAttribute("title", "SO-2026-0001");
  });

  it("ellipsis: false 才是显式关掉某一列的省略与 title", () => {
    const { cell } = renderTable(() => ({ width: "20%", ellipsis: false }));
    for (const header of ["单号", "名称", "数量", "规格"]) {
      expect(cell(header)).not.toHaveClass("cell-ellipsis");
      expect(cell(header)).not.toHaveAttribute("title");
    }
  });

  it("数字也能当 title（数量列），转成字符串而不是去掉", () => {
    const { cell } = renderTable(defaultMeta);
    expect(cell("数量")).toHaveAttribute("title", "1200");
  });

  it("值被翻译过的列：title 是屏幕上那串字，不是原始值", () => {
    const { cell } = renderTable(defaultMeta);
    // spec 的值是 null、accessorFn 把它变成屏幕上的「无」
    expect(cell("规格")).toHaveTextContent("无");
    expect(cell("规格")).toHaveAttribute("title", "无");
  });

  it("没有 accessor 的纯自定义 cell 列拿不到 title —— 这是契约，要 title 就写成 accessorFn", () => {
    // 这条不是"漏了"：DataTable 只能从**值**里取全文，`id` + 自定义 cell 的列没有值。
    // 物料清单页的「默认单位」因此改成了 accessorFn（见 app/procurement/materials/page.tsx）。
    const { cell } = renderTable(defaultMeta);
    expect(cell("备注")).toHaveTextContent("无备注");
    expect(cell("备注")).not.toHaveAttribute("title");
    expect(cell("备注")).not.toHaveClass("cell-ellipsis");
  });

  it("按钮那类 ReactNode 列：不给 title，也不带 cell-ellipsis（nowrap 会把折行的按钮裁掉）", () => {
    const { cell } = renderTable(defaultMeta);
    expect(cell("操作")).not.toHaveAttribute("title");
    expect(cell("操作")).not.toHaveClass("cell-ellipsis");
  });

  it("表头也给省略号 + hover 全文（固定布局下窄列的表头同样会被裁）", () => {
    const { head } = renderTable(defaultMeta);
    expect(head("单号")).toHaveClass("cell-ellipsis");
    expect(head("单号")).toHaveAttribute("title", "单号");
    expect(head("名称")).toHaveAttribute("title", "名称");
  });
});
