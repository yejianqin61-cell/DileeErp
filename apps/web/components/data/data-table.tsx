"use client";

import { flexRender, getCoreRowModel, getPaginationRowModel, useReactTable, type ColumnDef, type ColumnMeta, type RowData } from "@tanstack/react-table";
import type { ReactNode } from "react";
import { EmptyState, LoadingState } from "../feedback/states";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { Button } from "../ui/button";
import { displayText } from "../../lib/display-text";

/**
 * 列元数据（通过 TanStack 的 `ColumnMeta` 扩展挂在 `columnDef.meta` 上）。
 *
 * 为什么用 `meta` 而不是给 DataTable 加 `columnWidths` / `ellipsisColumns` 两个 props：
 * 宽度与「要不要省略」是**列自己的属性**，跟列定义写在同一个对象里才不会漂移
 * （两个平行的 Record 靠列 id 字符串对齐，改个 id 就会静默失效，而且看不出来）。
 */
declare module "@tanstack/react-table" {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface ColumnMeta<TData extends RowData, TValue> {
    /**
     * 固定列宽（CSS 长度，如 `"18%"`）。
     *
     * 2026-10-09 起这个字段的含义变了：**整张表一律是 `table-layout: fixed`**（见下面 `className` 处的注释），
     * 所以它不再是「要不要切固定布局」的开关，而是「这一列占多宽」：
     *   - 一列都没写的表 → 各列**均分**容器宽度（fixed 布局的默认行为），
     *     于是「某个 column 不限定宽度把整张表顶宽」从根上不会发生；
     *   - 写了 `width` 的表 → 按写的来，没写的列分剩下的空间
     *     （物料清单页 / 采购计划列表 / 凭证管理页就是这样）。
     * 想让关键列更宽、按钮列更宽，是**逐表配平**的活，见
     * `docs/design/table-column-width-audit-2026-10-09.md` 的方案 B。
     */
    width?: string;
    /**
     * 内容超宽时省略号截断，鼠标悬停用原生 `title` 展示全文（用户 2026-09-20 第 6 条）。
     *
     * 2026-10-09 起**默认开启**，不再需要逐列声明（用户当天：「每个 column 都能限定宽度。
     * 超过字数就省略显示。鼠标 hover 的时候再显示全部文字」）：只要这一格能取到字符串/数字，
     * 就自动拿到 `cell-ellipsis` + `title`。写 `ellipsis: false` 可以显式关掉某一列
     * （例如这串文字本来就必须完整显示、不想被截断）。
     * 控件列（按钮 / 缩略图 / 勾选框）本来就取不到字符串，因此自动不会加 —— 见 `ellipsisTitle`。
     */
    ellipsis?: boolean;
  }
}

/** 表格列元数据（导出给列定义使用，写 `meta` 时能拿到字面量约束）。 */
export type DataTableColumnMeta = ColumnMeta<RowData, unknown>;

/**
 * 读一列的元数据。
 *
 * `columnDef.meta` 在 TanStack 里是可选的 `unknown`，这里统一收口成上面的形状 ——
 * 只有一处读它，就不会出现「某个渲染分支忘了 meta」这种半生效的版式。
 */
function metaOf(meta: unknown): { width?: string; ellipsis?: boolean } {
  return (meta ?? {}) as { width?: string; ellipsis?: boolean };
}

/**
 * 把一格的内容变成能给 `title` 的字符串：**只认字符串与数字**。
 *
 * 为什么只认这两种：它们才是「被省略掉的文本」。ReactNode —— 按钮、缩略图、审计格那种
 * 「姓名 + 时间」两行结构 —— 拼成一句提示比没有更让人困惑；那类格子要提示就自己在容器上加
 * `title`（见 audit-columns.tsx 的 `auditActorCell`）。
 */
function titleText(value: unknown): string | undefined {
  if (typeof value === "string") return value || undefined;
  if (typeof value === "number") return String(value);
  return undefined;
}

/**
 * 悬停提示的文本，两层，顺序不能反：
 *   ① **渲染结果**是字符串 —— 显式 `cell` 直接返回文字的列；
 *   ② **这一格的值**（字符串/数字）—— 只写 `accessorKey` / `accessorFn` 的列。
 *
 * 第二层是 2026-10-08 补的（用户：「物料清单太宽了…超过就省略显示，鼠标hover才显示所有文字」）。
 * 在这之前只有第一层，而 TanStack 对没写 `cell` 的列用的是默认 cell（`props => props.renderValue()`），
 * `flexRender` 见到函数就 `createElement` —— `typeof rendered === "string"` 永不成立。
 * 表现是：省略号正常出现、鼠标悬停却一片空白，**而且看不出来是坏的**
 * （物料清单页的「物料编码 / 物料名称」第一次上线正是这个样子）。
 *
 * ⚠️ 第二层的前提是**这一列有值**：`accessorKey` / `accessorFn` 都取得到；
 * 只有 `id` + 自定义 `cell`（没写 accessor）的列取不到 —— 那种列要么改成 `accessorFn`
 * 把屏幕上显示的那串字作为值（物料清单页的「默认单位」就是），要么像审计格那样
 * 自己在容器上写 title（components/data/audit-columns.tsx）。
 */
function ellipsisTitle(rendered: ReactNode, value: unknown): string | undefined {
  return titleText(rendered) ?? titleText(value);
}

export function DataTable<T>({ columns, data, loading = false, empty, pageSize = 20, onRowDoubleClick, rowTitle, tableClassName }: { columns: ColumnDef<T, any>[]; data: T[]; loading?: boolean; empty?: ReactNode; pageSize?: number; onRowDoubleClick?: (row: T) => void; rowTitle?: string; tableClassName?: string }) {
  const table = useReactTable({ data, columns, initialState: { pagination: { pageSize } }, getCoreRowModel: getCoreRowModel(), getPaginationRowModel: getPaginationRowModel() });
  if (loading) return <LoadingState />;
  if (!data.length) return <>{empty ?? <EmptyState />}</>;
  const text = (value: ReactNode): ReactNode => typeof value === "string" ? String(displayText(value)) : value;
  /**
   * 2026-10-09：从「有列给了宽度才切固定布局」改成**一律固定布局**。
   *
   * 旧写法是 `columns.some((column) => metaOf(column.meta).width)` —— 一套「逐列自愿加入」制，
   * 而默认值是「不受限」。结果是全站 96 张表里只有 3 个文件（物料清单页 / 采购计划列表 / 凭证管理页）
   * 给列写过宽度，其余 78 张都是自动布局 + 每格 `white-space: nowrap`：
   * 每一列的最小宽度 = 该列最长的那串文字，于是表被顶出容器、只能左右拖 ——
   * 用户 2026-10-09：「我不希望会因为某个 column 不限定宽度而导致表格的左右宽度太大」。
   *
   * 固定布局下，**没给 `width` 的列由浏览器均分容器宽度**：表宽恒等于容器宽，「每个 column 都有上界」
   * 于是成为默认值，新加的表格不用再记得补宽度（盘点见
   * `docs/design/table-column-width-audit-2026-10-09.md`）。
   * 固定布局里内容再也撑不宽列，长文本只能在自己的格子里被省略 + hover 看全文。
   *
   * 唯一的例外走 CSS：财务页那些表靠**换行**一屏看全（2026-09-16 口径，实测 1366~1920 四个视口 0 溢出），
   * 口径是「金额与客户名换行也要看得全」而不是「省略掉、hover 才看」，
   * 所以 `.finance-page .ui-table.data-table-fixed` 那三条把它们放回自动布局。
   * 弹窗 / Sheet 走 Radix Portal 挂到 body（ui/dialog.tsx、ui/sheet.tsx），够不到 `.finance-page` ——
   * 那才是**要**被固定布局管住的一批（用户报的「确认应付的表单还需要左右滑动」就是它们）。
   */
  const className = ["data-table-fixed", tableClassName ?? ""].filter(Boolean).join(" ");
  return <><div className="table-wrap" data-testid="data-table"><Table className={className}><TableHeader>{table.getHeaderGroups().map(group => <TableRow key={group.id}>{group.headers.map(header => {
    // 表头也给省略号 + hover 全文：固定布局下窄列的表头同样会被 `overflow: hidden` 裁掉，
    // 而 `<TableHead>` 直到 2026-10-09 都没拿到过 `cell-ellipsis`（globals.css 里那条
    // `.ui-table-head.cell-ellipsis` 对 DataTable 一直是死代码）。列名是长词的页（「含税金额（本）」
    // 「最后修改人」）以前只能被硬裁，现在能悬停看全。
    const headerText = header.isPlaceholder ? null : text(flexRender(header.column.columnDef.header, header.getContext()));
    const headerWidth = metaOf(header.column.columnDef.meta).width;
    const headerEllipsis = typeof headerText === "string";
    return <TableHead key={header.id} style={headerWidth ? { width: headerWidth } : undefined} className={headerEllipsis ? "cell-ellipsis" : undefined} title={headerEllipsis ? headerText : undefined}>{headerText}</TableHead>;
  })}</TableRow>)}</TableHeader><TableBody>{table.getRowModel().rows.map(row => <TableRow key={row.id} data-testid="data-table-row" title={rowTitle} onDoubleClick={onRowDoubleClick ? () => onRowDoubleClick(row.original) : undefined} className={onRowDoubleClick ? "table-row-clickable" : undefined}>{row.getVisibleCells().map(cell => {
    const meta = metaOf(cell.column.columnDef.meta);
    const rendered = text(flexRender(cell.column.columnDef.cell, cell.getContext()));
    // 默认就是「超长省略 + hover 看全文」：能取到文字就给 title，`ellipsis: false` 才关掉。
    // `cell-ellipsis` 跟着 title 走而不是跟着开关走 —— 没有 title 的格子（按钮 / 缩略图 / 审计格）
    // 也就不会被 `nowrap` 裁掉按钮（物料清单页 2026-10-08 为这两列专门写过一条测试）。
    const title = meta.ellipsis === false ? undefined : ellipsisTitle(rendered, cell.getValue());
    return <TableCell key={cell.id} style={meta.width ? { width: meta.width } : undefined} className={title ? "cell-ellipsis" : undefined} title={title}>{rendered}</TableCell>;
  })}</TableRow>)}</TableBody></Table></div>{table.getPageCount() > 1 && <div className="table-pagination"><span>第 {table.getState().pagination.pageIndex + 1} / {table.getPageCount()} 页，共 {data.length} 条</span><div><Button size="sm" variant="secondary" disabled={!table.getCanPreviousPage()} onClick={() => table.previousPage()}>上一页</Button><Button size="sm" variant="secondary" disabled={!table.getCanNextPage()} onClick={() => table.nextPage()}>下一页</Button></div></div>}</>;
}

/**
 * 只有 accessorKey 的列不会返回字符串，`text()` 的「字符串才翻译」分支因此永不成立：
 * 表头是中文（表头是字符串），单元格却原样吐出 draft / confirmed 之类的英文枚举。
 *
 * DataTable 的既定契约是「默认渲染后端原值，需要中文化的列显式给 cell」
 * （workbench / qc / outsource 面板的测试都钉住了后端原值），
 * 所以这里不改成全局翻译，而是给需要的列提供这个 cell 工厂。
 */
export function statusCell<T extends { status?: string | null }>() {
  return ({ row }: { row: { original: T } }) => displayText(row.original.status ?? "") as ReactNode;
}
