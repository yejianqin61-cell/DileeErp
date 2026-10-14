"use client";

// 历史单未填货号补录（T12）。
//
// 老板要求每个销售单都有货号，但历史单是空的 —— 这个面板就是那张待办表。
// 口径：**绝不从品名/品番自动猜货号**。猜错会把两批不同的货并成一个货号，
// 比空着糟糕得多（空着只是查不到，猜错是查到错的）。所以这里只提供人工指派。
//
// 逐条走既有的 `PATCH /sales-orders/:id`（不新增批量接口）：
// 批量接口会绕开「已确认单改货号必须填原因」那道守卫与它的审计。
import { useCallback, useEffect, useState } from "react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { ItemNoInput, type ItemNoSuggestion } from "../sales/item-no-input";
import { EmptyState, ErrorState, LoadingState } from "../feedback/states";
import { ApiClientError, apiGet, apiPatch } from "../../lib/api-client";
import { notifySuccess } from "../ui/toaster";

type UnassignedOrder = {
  sales_order_id: string;
  order_no: string;
  customer_name: string | null;
  product_name: string;
  quantity: string;
  unit: string;
  order_date: string | null;
  status: string;
};

const STATUS_LABELS: Record<string, string> = { draft: "草稿", confirmed: "已确认", closed: "已关闭" };
const messageOf = (cause: unknown, fallback: string) => (cause instanceof ApiClientError ? cause.message : fallback);

export function UnassignedPanel() {
  const [rows, setRows] = useState<UnassignedOrder[]>([]);
  const [suggestions, setSuggestions] = useState<ItemNoSuggestion[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState<{ ids: string[]; itemNo: string; reason: string; busy: boolean; failure: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [orders, itemNos] = await Promise.all([
        apiGet<UnassignedOrder[]>("/reorder/unassigned-orders?page_size=100"),
        // 建议失败不影响指派（仍然可以直接输一个货号）。
        apiGet<ItemNoSuggestion[]>("/sales-orders/item-nos").catch(() => ({ data: [] as ItemNoSuggestion[], meta: {} })),
      ]);
      setRows(Array.isArray(orders.data) ? orders.data : []);
      setSuggestions(Array.isArray(itemNos.data) ? itemNos.data : []);
    } catch (cause) {
      setError(messageOf(cause, "待补录清单加载失败"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  /**
   * 需要填原因的两类单（后端也拦一道；这里先拦是为了不让用户白跑一次请求）：
   *   · 已确认单：任何修改都要原因（既有规则）；
   *   · 已关闭单：只放行「补货号」这一种改动，同样要留痕。
   */
  const needsReason = (ids: string[]) => ids.some((id) => rows.find((row) => row.sales_order_id === id)?.status !== "draft");

  async function assign() {
    if (!dialog) return;
    const itemNo = dialog.itemNo.trim();
    if (!itemNo) { setDialog({ ...dialog, failure: "请填写货号" }); return; }
    if (needsReason(dialog.ids) && !dialog.reason.trim()) { setDialog({ ...dialog, failure: "已确认 / 已关闭销售单修改必须填写原因" }); return; }
    setDialog({ ...dialog, busy: true, failure: "" });
    const failed: string[] = [];
    for (const id of dialog.ids) {
      const row = rows.find((candidate) => candidate.sales_order_id === id);
      try {
        // 发**原样**输入的值：归一（去空白/大小写匹配）是服务端的事，前端自己转一遍就会有两套规则。
        await apiPatch(`/sales-orders/${id}`, { item_no: itemNo, ...(dialog.reason.trim() ? { reason: dialog.reason.trim() } : {}) });
        // 成功的行立刻从待办里移除：整表重拉会让用户丢掉勾选状态。
        setRows((current) => current.filter((candidate) => candidate.sales_order_id !== id));
        setSelected((current) => current.filter((selectedId) => selectedId !== id));
      } catch (cause) {
        failed.push(`${row?.order_no ?? id}：${messageOf(cause, "指派失败")}`);
      }
    }
    if (failed.length) {
      // 部分失败要逐条说清：静默失败会让业务以为补完了、实际没补。
      setDialog({ ...dialog, busy: false, failure: `有 ${failed.length} 张单没补上 —— ${failed.join("；")}` });
      return;
    }
    notifySuccess(dialog.ids.length > 1 ? `已给 ${dialog.ids.length} 张单指派货号` : "货号已指派");
    setDialog(null);
  }

  const allSelected = rows.length > 0 && selected.length === rows.length;

  return (
    <section className="panel" data-testid="unassigned-panel">
      <div className="panel-heading">
        <h3>未填货号（{rows.length}）</h3>
        <div className="page-actions">
          <Button size="sm" variant="secondary" disabled={!selected.length} data-testid="unassigned-assign-selected" onClick={() => setDialog({ ids: selected, itemNo: "", reason: "", busy: false, failure: "" })}>
            批量指派（{selected.length}）
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void load()}>刷新</Button>
        </div>
      </div>
      <div className="panel-body">
        <p className="panel-note">历史单没有货号时按货号查不到它们的批次。这里逐张补 —— **不从品名猜测**，猜错会把两批不同的货并成一个货号。</p>
        {error ? <ErrorState message={error} onRetry={() => void load()} /> : loading ? <LoadingState label="正在加载待补录清单" /> : rows.length === 0 ? (
          <EmptyState title="没有待补录的销售单" description="所有销售单都有货号了。" />
        ) : (
          <div className="table-wrap">
            {/*
              手写表：列宽 + 超长省略 + hover 全文三件事都要自己做（DataTable 那套 meta 它用不上）。
              `.table-bounded` 是 globals.css 里给的固定布局入口；每列显式宽度、总和 100%：
              选择 4% / 销售单号 16% / 客户 16% / 产品 20% / 数量 8% / 下单日期 12% / 状态 10% / 操作 14%。
              产品名是本表唯一的长文本列（20%），客户次之（16%）；复选框列只要 4%。
              格子上的 `.ui-table-cell` 是 2026-10-09 补的 —— 原来这些 <td> 一个类都没有，
              连基础内边距和 nowrap 都没有（同一次治理的盘点发现，见 docs/design/table-column-width-audit-2026-10-09.md）。
            */}
            <table className="ui-table table-bounded" data-testid="unassigned-table">
              <thead>
                <tr>
                  <th className="ui-table-head" style={{ width: "4%" }}>
                    <input
                      type="checkbox"
                      aria-label="全选"
                      data-testid="unassigned-select-all"
                      checked={allSelected}
                      onChange={(event) => setSelected(event.target.checked ? rows.map((row) => row.sales_order_id) : [])}
                    />
                  </th>
                  <th className="ui-table-head cell-ellipsis" style={{ width: "16%" }} title="销售单号">销售单号</th>
                  <th className="ui-table-head cell-ellipsis" style={{ width: "16%" }} title="客户">客户</th>
                  <th className="ui-table-head cell-ellipsis" style={{ width: "20%" }} title="产品">产品</th>
                  <th className="ui-table-head cell-ellipsis" style={{ width: "8%" }} title="数量">数量</th>
                  <th className="ui-table-head cell-ellipsis" style={{ width: "12%" }} title="下单日期">下单日期</th>
                  <th className="ui-table-head cell-ellipsis" style={{ width: "10%" }} title="状态">状态</th>
                  <th className="ui-table-head cell-ellipsis" style={{ width: "14%" }} title="操作">操作</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.sales_order_id} data-testid={`unassigned-row-${row.order_no}`}>
                    <td className="ui-table-cell">
                      <input
                        type="checkbox"
                        aria-label={`选择 ${row.order_no}`}
                        data-testid={`unassigned-select-${row.order_no}`}
                        checked={selected.includes(row.sales_order_id)}
                        onChange={(event) => setSelected((current) => (event.target.checked ? [...current, row.sales_order_id] : current.filter((id) => id !== row.sales_order_id)))}
                      />
                    </td>
                    <td className="ui-table-cell cell-ellipsis" title={row.order_no}>{row.order_no}</td>
                    <td className="ui-table-cell cell-ellipsis" title={row.customer_name ?? "-"}>{row.customer_name ?? "-"}</td>
                    <td className="ui-table-cell cell-ellipsis" title={row.product_name}>{row.product_name}</td>
                    <td className="ui-table-cell cell-ellipsis" title={`${row.quantity} ${row.unit}`}>{row.quantity} {row.unit}</td>
                    <td className="ui-table-cell cell-ellipsis" title={row.order_date ? row.order_date.slice(0, 10) : "-"}>{row.order_date ? row.order_date.slice(0, 10) : "-"}</td>
                    <td className="ui-table-cell cell-ellipsis" title={STATUS_LABELS[row.status] ?? row.status}>{STATUS_LABELS[row.status] ?? row.status}</td>
                    <td className="ui-table-cell">
                      <Button size="sm" variant="secondary" data-testid={`unassigned-assign-${row.order_no}`} onClick={() => setDialog({ ids: [row.sales_order_id], itemNo: "", reason: "", busy: false, failure: "" })}>
                        指派货号
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Dialog open={Boolean(dialog)} onOpenChange={(open) => { if (!open && !dialog?.busy) setDialog(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>指派货号（{dialog?.ids.length ?? 0} 张单）</DialogTitle>
            <DialogDescription>货号可以由已有货号里挑，也可以直接输一个新的。改的是**历史单的货号**，不动任何下游事实。</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <label>货号
              <ItemNoInput value={dialog?.itemNo ?? ""} onChange={(value) => setDialog((current) => (current ? { ...current, itemNo: value, failure: "" } : current))} suggestions={suggestions} testId="unassigned-item-no" />
            </label>
            {dialog && needsReason(dialog.ids) ? (
              <label>修改原因（已确认 / 已关闭销售单必填）
                <Input data-testid="unassigned-reason" value={dialog.reason} onChange={(event) => setDialog({ ...dialog, reason: event.target.value, failure: "" })} placeholder="例如：历史单补货号" />
              </label>
            ) : null}
            {dialog?.failure ? <p className="status-error" role="alert" data-testid="unassigned-failure">{dialog.failure}</p> : null}
          </DialogBody>
          <DialogFooter>
            <Button variant="secondary" disabled={dialog?.busy} onClick={() => setDialog(null)}>取消</Button>
            <Button data-testid="unassigned-submit" disabled={dialog?.busy} onClick={() => void assign()}>{dialog?.busy ? "指派中…" : "确定"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
