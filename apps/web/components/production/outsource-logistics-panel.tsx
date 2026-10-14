"use client";
import { useEffect, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { ActionDialog, type ActionField } from "../ui/action-dialog";
import { Button } from "../ui/button";
import { DataTable } from "../data/data-table";
import { auditColumns, type AuditRow } from "../data/audit-columns";
import { EmptyState } from "../feedback/states";
import { ApiClientError, apiGet, apiPost, apiRequest } from "../../lib/api-client";
import { notifyError, notifySuccess } from "../ui/toaster";
type Batch = AuditRow & { id: string; batchNo: string; orderNo: string; status: string; plannedQuantity: string; dispatchedQuantity: string; receipts: Array<{ quantity: string; status: string }> };
type Transfer = AuditRow & { id: string; transferNo?: string; shipmentNo?: string; transferType: string; orderNo: string; quantity: string; status: string };
type ProductionOrder = { id: string; productionOrderNo: string; orderNo: string; status: string };
type Material = { id: string; materialCode?: string; name: string };
type Unit = { id: string; name: string; isActive?: boolean };
type PurchaseItem = { id: string; purchaseOrderNo?: string; orderNo?: string; material?: { name: string }; materialSnapshot?: { name?: string } };
function messageOf(cause: unknown, fallback: string) { return cause instanceof ApiClientError ? cause.message : fallback; }
/**
 * 外加工交接面板里**两张表**的业务列宽度。
 *
 * 两张表的列定义都接在 `auditColumns()` 后面（各 7 列 = 5 个业务列 + 2 个审计列），
 * 所以业务列声明宽度**合计恰好 84%**，剩下 16% 留给不给宽度的「创建人 / 最后修改人」
 * （改工厂用法会让 `lib/audit-columns-coverage.test.mjs` 的守卫失守）。
 *
 * 估算基准：1366 屏内容宽 1034px（1% = 10.34px），数据格 Arial 13px + 左右内边距 24px，
 * 表头 12px 加粗 + 24px。
 *
 * 取舍：每张表只有 5 个业务列却要摊 84%（平均 16.8%/列），所以「数量 / 短状态取 4%~6%」的通则
 * 在这里不可能照办（5 列全按 6% 只有 30%，凑不满 84%）—— 取舍是**先保总和精确**，
 * 宽出来的份额给两个长文本列（批次号 / 订单号 / 编号），短列压到 10%~12%
 * （它们的表头是 2~4 个汉字，本身就要 4.4%~7.0%）。
 */
const COLUMN_WIDTH = {
  // —— T1「外加工批次」（5 个业务列，合计 84%）——
  // 批次号：长文本列（"B20261009-01" 这类定长编号），给最宽的一档。
  batchNo: "22%",
  // 订单号：与批次号同为自由文本，且常带客户/年份前缀，是这张表最宽的一列。
  batchOrderNo: "26%",
  // 状态：只有草稿 / 直发中 / 已签收等 2~3 个汉字（36px + 24px ≈ 5.8%），10% 是「5 列摊 84%」的下限余量。
  batchStatus: "10%",
  // 计划/直发：一格塞两个数量（"1000 / 500"）≈ 10 字符 = 66.5px + 24px ≈ 8.8%，给 12%。
  batchQuantity: "12%",
  // 操作：最多同时 3 个按钮（直发 + 签收 + 仅草稿行的「删除」）= 3 × 44px + 2 × 4px 间距 = 140px ≈ 13.5%，向上取 14%。
  batchActions: "14%",

  // —— T2「回厂与直装柜」（5 个业务列，合计 84%；这一张没有操作列）——
  // 编号：transferNo 缺失时回落 shipmentNo，是这一行的身份，长文本列取最宽。
  transferNo: "28%",
  // 订单号：长文本列。
  transferOrderNo: "24%",
  // 类型：直发 / 余料回厂 / 成品回厂 / 直装柜（3~4 个汉字 = 48px + 24px ≈ 7.0%），给 12% 留余量。
  transferType: "12%",
  // 数量：纯数字（可能带小数）。
  transferQuantity: "10%",
  // 状态：2~3 个汉字。
  transferStatus: "10%",
} as const;

export function OutsourceLogisticsPanel({ scope }: { scope?: { orderNo: string; productionOrderId: string } } = {}) {
  const [batches, setBatches] = useState<Batch[]>([]); const [transfers, setTransfers] = useState<Transfer[]>([]); const [orders, setOrders] = useState<ProductionOrder[]>([]); const [materials, setMaterials] = useState<Material[]>([]); const [units, setUnits] = useState<Unit[]>([]); const [purchaseItems, setPurchaseItems] = useState<PurchaseItem[]>([]); const [dialog, setDialog] = useState<{ title: string; fields: ActionField[]; submit: (v: Record<string, string>) => void } | null>(null); const [error, setError] = useState("");
  async function load() { try { const orderQuery = scope ? `?order_no=${encodeURIComponent(scope.orderNo)}` : ""; const [b, r, s, o, m, u, p] = await Promise.all([apiGet<Batch[]>(`/production/outsource-logistics-batches${orderQuery}`), apiGet<Transfer[]>(`/production/outsource-logistics-batches/returns${orderQuery}`), apiGet<Transfer[]>(`/production/outsource-logistics-batches/direct-shipments${orderQuery}`), scope ? apiGet<ProductionOrder>(`/production/orders/${scope.productionOrderId}`) : apiGet<ProductionOrder[]>("/production/orders"), apiGet<Material[]>("/materials"), apiGet<Unit[]>("/units"), apiGet<Array<{ purchaseOrderNo: string; orderNo: string; items: Array<{ id: string; material?: { name: string } }> }>>("/purchase-orders")]); setBatches(b.data); setTransfers([...r.data, ...s.data]); setOrders((scope ? [o.data as ProductionOrder] : (o.data as ProductionOrder[])).filter((item) => ["draft", "in_progress"].includes(item.status))); setMaterials(m.data); setUnits(u.data.filter((item) => item.isActive !== false)); setPurchaseItems(p.data.flatMap((order) => order.items.map((item) => ({ ...item, purchaseOrderNo: order.purchaseOrderNo, orderNo: order.orderNo })))); } catch (cause) { setError(messageOf(cause, "外加工数据加载失败")); } }
  useEffect(() => { void load(); }, []); async function run(action: () => Promise<unknown>, success: string) { try { await action(); notifySuccess(success); await load(); } catch (cause) { notifyError(messageOf(cause, "操作失败")); } }
  function open(title: string, fields: ActionField[], submit: (v: Record<string, string>) => Promise<unknown>) { setDialog({ title, fields, submit: (v) => void run(() => submit(v), `${title}已完成`) }); }
  const orderOptions = orders.map((item) => ({ value: item.id, label: `${item.productionOrderNo} / ${item.orderNo}` }));
  const batchOptions = batches.map((item) => ({ value: item.id, label: `${item.batchNo} / ${item.orderNo}` }));
  const materialOptions = materials.map((item) => ({ value: item.id, label: `${item.materialCode ?? ""} / ${item.name}` }));
  const unitOptions = units.map((item) => ({ value: item.id, label: item.name }));
  const purchaseItemOptions = purchaseItems.map((item) => ({ value: item.id, label: `${item.purchaseOrderNo ?? "采购单"} / ${item.orderNo ?? ""} / ${item.material?.name ?? item.materialSnapshot?.name ?? "物料"}` }));
  function createBatch() { open("新建直发批次", [{ name: "production_order_id", label: "外加工生产单", type: "select", required: true, defaultValue: scope?.productionOrderId, options: orderOptions }, { name: "purchase_order_item_id", label: "采购明细", type: "select", required: true, options: purchaseItemOptions }, { name: "planned_quantity", label: "计划直发数量", type: "number", required: true }], (v) => apiPost("/production/outsource-logistics-batches", v)); }
  function dispatch(batch: Batch) { open("登记直发", [{ name: "quantity", label: "直发数量", type: "number", required: true }, { name: "dispatch_date", label: "直发日期", type: "date", required: true }, { name: "proof_remark", label: "交接凭据", required: true }], (v) => apiPost(`/production/outsource-logistics-batches/${batch.id}/dispatch`, v)); }
  function receipt(batch: Batch) { open("登记签收", [{ name: "quantity", label: "签收数量", type: "number", required: true }, { name: "receipt_date", label: "签收日期", type: "date", required: true }, { name: "receiver_name", label: "签收人" }, { name: "proof_remark", label: "签收凭据", required: true }, { name: "idempotency_key", label: "幂等键", required: true, defaultValue: `web-${Date.now()}` }], (v) => apiPost(`/production/outsource-logistics-batches/${batch.id}/receipts`, v)); }
  function transfer(title: string, path: string) { open(title, [{ name: "production_order_id", label: "生产单", type: "select", required: true, defaultValue: scope?.productionOrderId, options: orderOptions }, { name: "logistics_batch_id", label: "直发批次", type: "select", required: path.endsWith("/material"), options: batchOptions, placeholder: "原料回厂时填写" }, { name: "material_id", label: "物料", type: "select", required: path.endsWith("/material"), options: materialOptions, placeholder: "原料回厂时填写" }, { name: "unit_id", label: "单位", type: "select", required: true, options: unitOptions }, { name: "product_description", label: "成品/物料描述", required: path !== "/production/outsource-logistics-batches/returns/material" }, { name: "quantity", label: "数量", type: "number", required: true }, { name: "transfer_date", label: "日期", type: "date", required: true }, { name: "shipment_date", label: "装柜日期", type: "date", required: path.endsWith("/direct-shipments") }, { name: "logistics_reference", label: "物流参考号", required: path.endsWith("/direct-shipments") }], (v) => {
    // 只提交对应路径 DTO 允许的键（后端 forbidNonWhitelisted 会 400 任何多余键/空串），
    // 表单元件中不属于该 DTO 的字段一律丢弃；可选键为空时置 undefined 由 JSON 序列化省略。
    if (path.endsWith("/returns/material")) {
      return apiPost(path, { production_order_id: v.production_order_id, logistics_batch_id: v.logistics_batch_id, material_id: v.material_id, unit_id: v.unit_id, quantity: v.quantity, transfer_date: v.transfer_date, remark: undefined });
    }
    if (path.endsWith("/returns/finished-goods")) {
      return apiPost(path, { production_order_id: v.production_order_id, unit_id: v.unit_id, product_description: v.product_description, quantity: v.quantity, transfer_date: v.transfer_date, remark: undefined });
    }
    return apiPost(path, { production_order_id: v.production_order_id, unit_id: v.unit_id, product_description: v.product_description, quantity: v.quantity, shipment_date: v.shipment_date, logistics_reference: v.logistics_reference, remark: undefined });
  }); }
  const batchColumns: ColumnDef<Batch>[] = [{ accessorKey: "batchNo", header: "批次", meta: { width: COLUMN_WIDTH.batchNo } }, { accessorKey: "orderNo", header: "订单号", meta: { width: COLUMN_WIDTH.batchOrderNo } }, { accessorKey: "status", header: "状态", meta: { width: COLUMN_WIDTH.batchStatus } }, { id: "quantity", header: "计划/直发", meta: { width: COLUMN_WIDTH.batchQuantity }, cell: ({ row }) => `${row.original.plannedQuantity} / ${row.original.dispatchedQuantity}` }, ...auditColumns<Batch>(), { id: "actions", header: "操作", meta: { width: COLUMN_WIDTH.batchActions }, cell: ({ row }) => <><Button size="sm" variant="secondary" onClick={() => dispatch(row.original)}>直发</Button><Button size="sm" variant="secondary" onClick={() => receipt(row.original)}>签收</Button>{row.original.status === "draft" && <Button size="sm" variant="destructive" onClick={() => void run(() => apiRequest(`/production/outsource-logistics-batches/${row.original.id}`, { method: "DELETE" }), "草稿已删除")}>删除</Button>}</> }];
  const transferColumns: ColumnDef<Transfer>[] = [{ id: "transferNo", header: "编号", meta: { width: COLUMN_WIDTH.transferNo }, cell: ({ row }) => row.original.transferNo ?? row.original.shipmentNo ?? "-" }, { accessorKey: "orderNo", header: "订单号", meta: { width: COLUMN_WIDTH.transferOrderNo } }, { accessorKey: "transferType", header: "类型", meta: { width: COLUMN_WIDTH.transferType } }, { accessorKey: "quantity", header: "数量", meta: { width: COLUMN_WIDTH.transferQuantity } }, { accessorKey: "status", header: "状态", meta: { width: COLUMN_WIDTH.transferStatus } }, ...auditColumns<Transfer>()];
  return <section className="panel outsource-panel"><ActionDialog open={Boolean(dialog)} onOpenChange={(openState) => { if (!openState) setDialog(null); }} title={dialog?.title ?? "操作"} fields={dialog?.fields ?? []} onAddCategory={(field) => setError(`${field.label}为业务记录，请在对应模块建立`)} onSubmit={(values) => { dialog?.submit(values); setDialog(null); }} /><div className="panel-heading"><h2>外加工交接</h2><div className="page-actions"><Button onClick={createBatch}>新建直发批次</Button><Button variant="secondary" onClick={() => transfer("余料回厂", "/production/outsource-logistics-batches/returns/material")}>余料回厂</Button><Button variant="secondary" onClick={() => transfer("成品回厂", "/production/outsource-logistics-batches/returns/finished-goods")}>成品回厂</Button><Button variant="secondary" onClick={() => transfer("直装柜", "/production/outsource-logistics-batches/direct-shipments")}>直装柜</Button></div></div>{error && <p className="status-error panel-body">{error}</p>}<div className="panel-body"><DataTable columns={batchColumns} data={batches} empty={<EmptyState title="暂无外加工批次" />} /><h3>回厂与直装柜</h3><DataTable columns={transferColumns} data={transfers} empty={<EmptyState title="暂无回厂或直装柜记录" />} /></div></section>;
}
