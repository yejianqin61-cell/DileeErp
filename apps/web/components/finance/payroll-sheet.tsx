"use client";

// 可编辑满页表格（工资台账用）。
//
// 为什么不用 `DataTable`：那是「只读渲染 + 分页」的契约，而这里要的是单元格级编辑、键盘导航与
// **逐格保存**。把编辑能力塞进 DataTable 会让它对所有调用方都变形（应收/应付/库存几十处都在用），
// 因此单独一个组件，DataTable 保持原样。
//
// 交互（按 Excel/WPS 的习惯）：
//   - 单击单元格：可编辑的直接进入编辑（值全选，便于直接覆盖）；
//   - Enter / F2：编辑当前格；Esc：取消；Tab：保存并右移（行末回到下一行首格）；
//   - 方向键：在格与格之间移动（容器可聚焦，未进入编辑时生效）；
//   - 失焦：保存。值没变则不打接口（避免「点一下也写一次库」）；
//   - 清空金额格 = 0（不是空字符串，后端金额列不接受空值）；
//   - 保存失败：不改变显示值（父组件不刷新行数据），格子标红并在表格上方给出失败原因。
import { useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";
import { EmptyState } from "../feedback/states";

export type SheetEditKind = "money" | "text";

export type PayrollSheetColumn<T> = {
  key: string;
  header: string;
  /** 单元格显示文本（只读列也必须有，用于显示与「值是否变化」的比较）；带 render 的列可以不给。 */
  text?: (row: T) => string;
  /** 可编辑时返回编辑类型；返回 undefined 表示只读。 */
  edit?: (row: T) => SheetEditKind | undefined;
  /** 只读原因，挂在 title 上：用户悬停即可知道为什么这一格改不了。 */
  readOnlyHint?: (row: T) => string | undefined;
  /** 自定义渲染（操作列这种带按钮的列）；给了 render 的列不参与编辑与导航。 */
  render?: (row: T) => ReactNode;
  /** 金额列右对齐。 */
  numeric?: boolean;
  /** 合计行是否参与求和（仅对有数值意义的列）。 */
  total?: boolean;
};

/** 金额格式：非负、最多 4 位小数（与后端 Decimal(18,4) 同量纲）。 */
const MONEY = /^\d+(?:\.\d{1,4})?$/;

/**
 * 显示用求和：把金额按 1e4 缩放成整数再相加，避免 0.1+0.2 这类浮点误差。
 * 这是**显示值**，权威金额始终来自后端（列表接口已经算好应发/已付/未付）。
 */
function sumDecimal(values: string[]): string {
  const scaled = values.reduce((sum, value) => sum + Math.round(Number(value) * 10000), 0);
  return (scaled / 10000).toFixed(4);
}

export function PayrollSheet<T extends { id: string }>({ columns, rows, onCommit, rowTestId, totalLabel = "合计（当前筛选结果）", hint, empty }: {
  columns: PayrollSheetColumn<T>[];
  rows: T[];
  /** 有可编辑列时必须提供；全只读表格（如工资付款）不需要。 */
  onCommit?: (row: T, key: string, value: string) => Promise<void>;
  rowTestId?: (row: T) => string;
  totalLabel?: string;
  /** 表头上方的说明文案；不给时按「有没有可编辑列」给默认文案。 */
  hint?: ReactNode;
  /** 空态；不给时用工资台账的默认空态。 */
  empty?: ReactNode;
}) {
  const [active, setActive] = useState<{ rowId: string; key: string } | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState<{ rowId: string; key: string } | null>(null);
  const [failure, setFailure] = useState<{ rowId: string; key: string; message: string } | null>(null);
  // Enter 保存后输入框会卸载，浏览器仍可能再抛一次 blur；用一个 ref 吃掉那次重复的保存。
  const blurGuard = useRef(false);
  /**
   * 当前选中格的**同步**副本。
   *
   * 保存是异步的：用户可能在 PATCH 还没回来时已经点了下一格开始编辑。保存完成时如果无条件
   * `setEditing(false)`，就会把用户刚点开的那一格又关掉；而 state 在异步回调里读到的是旧值，
   * 所以必须用 ref 记住「我保存的是不是当前选中的那一格」。
   */
  const activeRef = useRef<{ rowId: string; key: string } | null>(null);

  const navigable = useMemo(() => columns.filter((column) => !column.render), [columns]);
  const totalColumns = useMemo(() => columns.filter((column) => column.total && !column.render), [columns]);
  const editableColumns = useMemo(() => columns.some((column) => column.edit), [columns]);

  if (!rows.length) return <>{empty ?? <EmptyState title="本月暂无工资台账" description="选择月份后会自动导入全部员工；如果刚导入还没有数据，点「刷新」重试。" />}</>;

  function selectCell(next: { rowId: string; key: string }) {
    activeRef.current = next;
    setActive(next);
  }

  function activate(row: T, column: PayrollSheetColumn<T>) {
    if (column.render) return;
    setFailure(null);
    selectCell({ rowId: row.id, key: column.key });
    const kind = column.edit?.(row);
    if (kind) {
      setDraft(column.text?.(row) ?? "");
      setEditing(true);
    } else {
      setEditing(false);
    }
  }

  async function commit(row: T, column: PayrollSheetColumn<T>) {
    const kind = column.edit?.(row);
    if (!kind || !onCommit) { setEditing(false); return; }
    const raw = draft.trim();
    // 清空金额格按 0 处理：后端金额列不接受空字符串，用户的直觉也是「清掉就是不要了」。
    const value = kind === "money" && raw === "" ? "0" : raw;
    const stillActive = () => activeRef.current?.rowId === row.id && activeRef.current?.key === column.key;
    if (kind === "money" && !MONEY.test(value)) {
      setFailure({ rowId: row.id, key: column.key, message: "金额必须是非负数字，最多 4 位小数" });
      return;
    }
    if (value === (column.text?.(row) ?? "")) { if (stillActive()) setEditing(false); setFailure(null); return; }
    setFailure(null);
    setSaving({ rowId: row.id, key: column.key });
    try {
      await onCommit(row, column.key, value);
      blurGuard.current = true;
      if (stillActive()) { setEditing(false); setDraft(""); }
    } catch (error) {
      setFailure({ rowId: row.id, key: column.key, message: error instanceof Error ? error.message : "保存失败" });
      blurGuard.current = true;
      if (stillActive()) setEditing(false);
    } finally {
      setSaving(null);
    }
  }

  function move(rowIndex: number, columnIndex: number, deltaRow: number, deltaColumn: number) {
    const nextRow = Math.min(Math.max(rowIndex + deltaRow, 0), rows.length - 1);
    const nextColumn = Math.min(Math.max(columnIndex + deltaColumn, 0), navigable.length - 1);
    selectCell({ rowId: rows[nextRow].id, key: navigable[nextColumn].key });
    setEditing(false);
  }

  function onCellKeyDown(event: React.KeyboardEvent<HTMLTableCellElement>, row: T, column: PayrollSheetColumn<T>) {
    if (editing) return;
    if (!active) return;
    const rowIndex = rows.findIndex((item) => item.id === active.rowId);
    const columnIndex = navigable.findIndex((item) => item.key === active.key);
    if (rowIndex < 0 || columnIndex < 0) return;
    if (event.key === "ArrowUp") { event.preventDefault(); move(rowIndex, columnIndex, -1, 0); }
    else if (event.key === "ArrowDown") { event.preventDefault(); move(rowIndex, columnIndex, 1, 0); }
    else if (event.key === "ArrowLeft") { event.preventDefault(); move(rowIndex, columnIndex, 0, -1); }
    else if (event.key === "ArrowRight") { event.preventDefault(); move(rowIndex, columnIndex, 0, 1); }
    else if (event.key === "Enter" || event.key === "F2") {
      event.preventDefault();
      const kind = column.edit?.(row);
      if (!kind) return;
      setDraft(column.text?.(row) ?? "");
      setEditing(true);
    }
  }

  function onInputKeyDown(event: React.KeyboardEvent<HTMLInputElement>, row: T, column: PayrollSheetColumn<T>) {
    if (event.key === "Enter") { event.preventDefault(); void commit(row, column); return; }
    if (event.key === "Escape") { event.preventDefault(); blurGuard.current = true; setEditing(false); setDraft(""); setFailure(null); return; }
    if (event.key === "Tab") {
      event.preventDefault();
      const rowIndex = rows.findIndex((item) => item.id === row.id);
      const columnIndex = navigable.findIndex((item) => item.key === column.key);
      void commit(row, column);
      if (rowIndex < 0 || columnIndex < 0) return;
      if (event.shiftKey && columnIndex === 0 && rowIndex > 0) move(rowIndex, navigable.length, -1, 0);
      else if (!event.shiftKey && columnIndex === navigable.length - 1 && rowIndex < rows.length - 1) move(rowIndex, -1, 1, 0);
      else move(rowIndex, columnIndex, 0, event.shiftKey ? -1 : 1);
    }
  }

  return <div className="payroll-sheet">
    <p className="panel-note payroll-sheet-note" data-testid="payroll-sheet-hint">
      {hint ?? (editableColumns
        ? "单击单元格即可修改（Enter 保存、Esc 取消、Tab 右移、方向键换格）；清空金额 = 0。车间工人的「基本工资」由生产日报自动汇总，是唯一不可改的金额格；已确认/已付款台账请先用「回到草稿」或用工资调整单。"
        : "本表只读；操作请在每行的操作列里完成。")}
    </p>
    {failure ? <p className="panel-note payroll-sheet-error" role="alert" data-testid="payroll-sheet-error">保存失败：{failure.message}</p> : null}
    <div className="table-wrap payroll-sheet-scroll" tabIndex={0} role="grid" aria-label="工资台账表格" data-testid="payroll-sheet">
      <table className="ui-table payroll-sheet-table">
        <thead className="ui-table-header">
          <tr>{columns.map((column) => <th key={column.key} className={cn("ui-table-head", column.numeric && "payroll-sheet-numeric")} data-testid={`payroll-sheet-head-${column.key}`}>{column.header}</th>)}</tr>
        </thead>
        <tbody className="ui-table-body">
          {rows.map((row) => <tr key={row.id} className="ui-table-row" data-testid={rowTestId?.(row)}>
            {columns.map((column) => {
              const isActive = active?.rowId === row.id && active.key === column.key;
              const isEditingCell = isActive && editing && !column.render;
              const isSaving = saving?.rowId === row.id && saving.key === column.key;
              const failed = failure?.rowId === row.id && failure.key === column.key;
              const editable = column.render ? undefined : column.edit?.(row);
              const hint = column.readOnlyHint?.(row);
              return <td
                key={column.key}
                data-testid={`payroll-cell-${row.id}-${column.key}`}
                data-readonly={editable ? undefined : "true"}
                data-column={column.key}
                tabIndex={-1}
                title={isActive ? undefined : hint}
                className={cn("ui-table-cell", column.numeric && "payroll-sheet-numeric", editable && "payroll-sheet-editable", isActive && "payroll-sheet-active", failed && "payroll-sheet-failed", isSaving && "payroll-sheet-saving")}
                onClick={() => activate(row, column)}
                onKeyDown={(event) => onCellKeyDown(event, row, column)}
              >
                {column.render
                  ? column.render(row)
                  : isEditingCell
                    ? <input
                      className="payroll-sheet-input"
                      data-testid={`payroll-cell-input-${row.id}-${column.key}`}
                      aria-label={`${column.header}（${row.id}）`}
                      value={draft}
                      inputMode={editable === "money" ? "decimal" : "text"}
                      autoFocus
                      onChange={(event) => setDraft(event.target.value)}
                      onFocus={(event) => event.target.select()}
                      onBlur={() => { if (blurGuard.current) { blurGuard.current = false; return; } void commit(row, column); }}
                      onKeyDown={(event) => onInputKeyDown(event, row, column)}
                    />
                    : isSaving ? "保存中…" : (column.text?.(row) ?? "")}
              </td>;
            })}
          </tr>)}
        </tbody>
        {totalColumns.length ? <tfoot className="ui-table-footer" data-testid="payroll-sheet-totals">
          <tr>
            {columns.map((column, index) => <td key={column.key} className={cn("ui-table-cell", column.numeric && "payroll-sheet-numeric")} data-testid={`payroll-sheet-total-${column.key}`}>
              {index === 0 ? totalLabel : column.total ? sumDecimal(rows.map((row) => column.text?.(row) ?? "0")) : ""}
            </td>)}
          </tr>
        </tfoot> : null}
      </table>
    </div>
    <p className="panel-note" data-testid="payroll-sheet-count">共 {rows.length} 条；合计行是当前筛选结果的显示值，权威金额以「应发/已付/未付」为准。</p>
  </div>;
}
