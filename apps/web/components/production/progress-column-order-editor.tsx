"use client";

// 生产进度表的工序列排序编辑器（拖拽 + 上移/下移 + 恢复默认）。
//
// 为什么单独一个组件：导出面板本身是「一行一个弹窗」的压缩写法，把拖拽逻辑塞进去会看不出边界；
// 而且这段交互要能被真实渲染测试钉住（拖拽、按钮、顺序回显）。
//
// 交互取舍：
//   - 原生 HTML5 拖拽（draggable/onDragStart/onDrop），不引入 dnd 依赖；
//   - 同时给「上移/下移」按钮 —— 触屏、键盘与自动化测试都靠它，拖拽不是唯一入口；
//   - 顺序是**导出显示偏好**，不写回生产工序的 sequence_no（那是车间实际生产顺序）。
import { useRef, useState } from "react";
import { Button } from "../ui/button";
import { applyColumnOrder, isDefaultColumnOrder, moveColumn } from "../../lib/progress-column-order";

export type ProgressColumn = { id: string; name: string };

export function ProgressColumnOrderEditor({ operations, order, onChange }: { operations: ProgressColumn[]; order: string[]; onChange: (ids: string[]) => void }) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  // 拖拽源用 ref 记：drop 与 dragstart 之间可能隔着一次渲染，靠 state 读来源在真实浏览器里会偶发读到旧值。
  const dragFrom = useRef<number | null>(null);
  // 列表按「用户顺序 + 未提到的接在后面」渲染，与后端排表头的规则完全一致。
  const rows = applyColumnOrder(operations, order);
  const custom = !isDefaultColumnOrder(operations, order);

  function move(from: number, to: number) {
    onChange(moveColumn(rows.map((row) => row.id), from, to));
  }

  function endDrag() {
    dragFrom.current = null;
    setDragIndex(null);
  }

  if (!operations.length) return <p className="panel-note" data-testid="progress-column-order-editor">该订单还没有工序，导出后表头只有「日期」列。</p>;

  return <div className="progress-column-editor" data-testid="progress-column-order-editor">
    <p className="panel-note">
      拖动行（或点↑↓）调整工序列的先后，导出的生产进度表会按这个顺序排列工序 column。
      没列出的工序会按默认顺序排在后面；这里只改表的列序，不影响生产单里的工序顺序。
    </p>
    <ol className="progress-column-list">
      {rows.map((row, index) => <li
        key={row.id}
        data-testid={`progress-column-${row.id}`}
        draggable
        onDragStart={() => { dragFrom.current = index; setDragIndex(index); }}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => { event.preventDefault(); const from = dragFrom.current; if (from !== null && from !== index) move(from, index); endDrag(); }}
        onDragEnd={endDrag}
        className={dragIndex === index ? "progress-column-row dragging" : "progress-column-row"}
      >
        <span className="progress-column-index">{index + 1}</span>
        <span className="progress-column-name">{row.name || "（未命名工序）"}</span>
        <span className="progress-column-actions">
          <Button size="sm" variant="ghost" data-testid={`progress-column-up-${row.id}`} disabled={index === 0} onClick={() => move(index, index - 1)} aria-label={`${row.name || "未命名工序"} 上移`}>↑</Button>
          <Button size="sm" variant="ghost" data-testid={`progress-column-down-${row.id}`} disabled={index === rows.length - 1} onClick={() => move(index, index + 1)} aria-label={`${row.name || "未命名工序"} 下移`}>↓</Button>
        </span>
      </li>)}
    </ol>
    <div className="page-actions">
      <Button size="sm" variant="secondary" data-testid="progress-column-reset" disabled={!custom} onClick={() => onChange([])}>恢复默认顺序</Button>
      <span className="panel-note" data-testid="progress-column-order-state">{custom ? "已自定义列序（导出时随请求带上，并记住这台机器上的选择）" : "当前是默认列序"}</span>
    </div>
  </div>;
}
