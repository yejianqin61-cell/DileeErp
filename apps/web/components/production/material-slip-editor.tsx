"use client";

// 领料单 / 补料单的全屏编辑页（不再用窄侧栏 Sheet：列多时物料名与规格会挤在一起互相覆盖）。
//
// 口径：领料单与补料单都只绑定生产单（一个生产单可多张领料单）；物料只能从该生产单订单的 BOM 明细里选；
// 保存草稿后可随时回来继续编辑；保存并提交只是把单据交给仓库（draft → pending_outbound），
// 本页**不扣减**原料库存 —— 真正的出库由仓库在「待出库通知」里确认出库（补料单走 post-replenishment，单号 MC-）。
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { PageHeader } from "../layout/app-shell";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { SearchableSelect } from "../ui/searchable-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { EmptyState, ErrorState, LoadingState } from "../feedback/states";
import { ApiClientError, apiGet, apiPatch, apiPost } from "../../lib/api-client";
import { createMovementPath, isMaterialMovementDocumentType } from "../../lib/material-slip-api";
import { notifyError, notifySuccess } from "../ui/toaster";

type ProductionOrder = { id: string; productionOrderNo: string; orderNo: string; executionMode?: string; status?: string; bom?: { id: string } | null; bomId?: string | null };
type Material = { id: string; materialCode?: string; name: string; isActive?: boolean };
type RawBalance = { material_id: string; unit_name: string; quantity: string };
type BomItem = { materialId: string; materialName: string; model?: string | null; specificationModel?: string | null; requiredQuantity: string; unit: string; unitId?: string | null; supplierId?: string | null; supplierName?: string | null };
type SlipLine = { materialId: string; quantity: string; supplier_id?: string | null; remark: string };
type PreviewLine = { material_id: string; material_code?: string; material_name?: string; model?: string | null; unit?: string | null; color?: string | null; approved_usage?: string | null; bom_reference_quantity?: string | null; inventory_quantity?: string | null; available_before?: string | null; purchase_received_quantity?: string | null; purchase_outstanding_quantity?: string | null; cumulative_issued_before?: string | number | null; cumulative_issued_after?: string | null; production_outstanding_quantity?: string | null; requested_replenishment_quantity?: string | null;
  /** 与领料单打印件同名的四个数量：后端按同一口径算好（material-slip-quantity），页面只显示、不自己换算。 */
  material_quantity?: number | null; issued_quantity?: number | null; current_quantity?: number | null; remaining_quantity?: number | null; risks?: Array<{ type?: string; message?: string }>;
  /** 同一物料同供应商下的档位结存，供「当前库存量」列 hover 展示各档。 */
  available_by_supplier?: Array<{ supplier_id: string | null; supplier_name: string | null; quantity: string }>;
  supplier_id?: string | null;
  supplier_name?: string | null };
type Preview = { lines: PreviewLine[]; warnings?: string[] };
type Movement = { id: string; movementNo: string; documentType: string; status: string; productionOrderId: string; reason?: string | null; lines: Array<{ materialId: string; quantity: string; remark?: string | null; supplier_id?: string | null; supplier_name?: string | null }> };

const messageOf = (cause: unknown, fallback: string) => cause instanceof ApiClientError ? cause.message : fallback;

export function MaterialSlipEditor({ documentType }: { documentType: "issue" | "replenishment" }) {
  const searchParams = useSearchParams();
  const movementId = searchParams.get("movement_id");
  const initialOrderId = searchParams.get("production_order_id") ?? "";
  const isReplenishment = documentType === "replenishment";
  const title = isReplenishment ? "新建补料单" : "新建领料单";
  const listHref = "/production/material-issues";

  const [orders, setOrders] = useState<ProductionOrder[]>([]);
  const [rawBalances, setRawBalances] = useState<RawBalance[]>([]);
  const [bomItems, setBomItems] = useState<BomItem[]>([]);
  const [productionOrderId, setProductionOrderId] = useState(initialOrderId);
  const [reason, setReason] = useState("");
  const [lines, setLines] = useState<SlipLine[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [editingId, setEditingId] = useState<string | null>(movementId);
  const [editingNo, setEditingNo] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // 不能编辑的原因（单据已过账/类型不符/深链的生产单不可领料）：与普通错误分开，
  // 命中时整页只显示原因，不渲染可编辑表单，避免误改已过账单据。
  const [blocked, setBlocked] = useState("");

  const bomMaterialOptions = useMemo(() => {
    const seen = new Set<string>();
    return bomItems
      .filter((item) => { if (seen.has(item.materialId)) return false; seen.add(item.materialId); return true; })
      .map((item) => ({
        value: item.materialId,
        label: `${item.materialName} / ${item.model ?? item.specificationModel ?? "无型号"} / 需 ${item.requiredQuantity}${item.unit}${
          item.supplierName ? ` / ${item.supplierName}` : ""
        }`,
        supplier_id: item.supplierId ?? null,
      }));
  }, [bomItems]);
  const materialLabel = (materialId: string) => bomMaterialOptions.find((option) => option.value === materialId)?.label ?? materialId;
  /** 单位：下拉文案里有 BOM 明细的单位，明细行本身没有；取不到就显示「-」。 */
  const unitOf = (materialId: string) => bomItems.find((item) => item.materialId === materialId)?.unit || "-";
  const balanceOf = (materialId: string) => rawBalances.filter((balance) => balance.material_id === materialId).map((balance) => `${balance.quantity} ${balance.unit_name}`).join("、") || "0";
  /** 同一物料 + 同一单位下的供应商档位结存（来自 preview 的 available_by_supplier），供「当前库存量」 hover 展示。 */
  const supplierStockOf = (materialId: string): string => {
    if (!preview?.lines.length) return "";
    const line = preview.lines.find((l) => l.material_id === materialId);
    if (!line?.available_by_supplier?.length) return "";
    return line.available_by_supplier.map((b) => `${b.supplier_name ?? "未指定"}: ${b.quantity}`).join("、");
  };

  /** 切换/加载生产单时只取该生产单订单的 BOM 明细，避免误选别的订单物料。 */
  async function loadBomFor(orderId: string, orderList = orders): Promise<BomItem[]> {
    const bomId = orderList.find((item) => item.id === orderId)?.bom?.id ?? orderList.find((item) => item.id === orderId)?.bomId ?? null;
    if (!bomId) { setBomItems([]); return []; }
    try {
      const items = (await apiGet<{ items: BomItem[] }>(`/boms/${bomId}`)).data.items ?? [];
      setBomItems(items);
      return items;
    } catch (cause) {
      setBomItems([]);
      notifyError(messageOf(cause, "BOM 明细加载失败"));
      return [];
    }
  }

  async function refreshPreview(nextOrderId: string, nextLines: SlipLine[]) {
    if (isReplenishment || !nextOrderId || !nextLines.length) { setPreview(null); return; }
    try {
      const result = await apiPost<Preview>("/production/material-movements/issue-preview", { production_order_id: nextOrderId, lines: nextLines.map((line) => ({ material_id: line.materialId, quantity: line.quantity, supplier_id: line.supplier_id ?? undefined, remark: line.remark || undefined })) });
      setPreview(result.data);
    } catch { setPreview(null); }
  }

  useEffect(() => {
    void (async () => {
      setLoading(true);
      setError("");
      setBlocked("");
      try {
        const [orderResult, balanceResult, movementResult] = await Promise.all([
          apiGet<ProductionOrder[]>("/production/orders"),
          apiGet<RawBalance[]>("/inventory/raw-material-balances").catch(() => ({ data: [] as RawBalance[], meta: {} })),
          movementId ? apiGet<Movement>(`/production/material-movements/${movementId}`) : Promise.resolve({ data: null as Movement | null, meta: {} }),
        ]);
        const available = orderResult.data.filter((item) => item.executionMode === "in_house" && item.status === "in_progress");
        setOrders(available);
        setRawBalances(balanceResult.data);
        const movement = movementResult.data;
        if (movement) {
          if (!isMaterialMovementDocumentType(movement.documentType) || movement.documentType !== documentType) { setBlocked(`该单据类型与当前页面不一致（${movement.documentType}），请从对应入口打开。`); return; }
          if (movement.status !== "draft") { setBlocked("只有草稿单据可以在这里编辑；已过账请先在列表里「重新打开」退成草稿。"); return; }
          setEditingId(movement.id);
          setEditingNo(movement.movementNo);
          setProductionOrderId(movement.productionOrderId);
          if (isReplenishment) setReason(movement.reason ?? "");
          const items = await loadBomFor(movement.productionOrderId, orderResult.data);
          const editLines = movement.lines.map((line) => ({ materialId: line.materialId, quantity: line.quantity, supplier_id: line.supplier_id ?? null, remark: line.remark ?? "" }));
          setLines(editLines.length ? editLines : [{ materialId: items[0]?.materialId ?? "", quantity: "1", remark: "" }]);
          void refreshPreview(movement.productionOrderId, editLines);
          return;
        }
        if (initialOrderId && !available.some((item) => item.id === initialOrderId)) {
          // 带 production_order_id 进来但该生产单不可领料时，绝不悄悄换成别的生产单：
          // 那会让用户以为在给 A 单领料，实际单据挂到了 B 单。
          setProductionOrderId("");
          setLines([]);
          setBlocked("该生产单不是「生产中」的厂内生产单，不能领料：请改选其它生产单，或先启动生产。");
          return;
        }
        const orderId = available.some((item) => item.id === initialOrderId) ? initialOrderId : (available[0]?.id ?? "");
        setProductionOrderId(orderId);
        const items = await loadBomFor(orderId, orderResult.data);
        const firstLines: SlipLine[] = [{ materialId: items[0]?.materialId ?? "", quantity: "1", remark: "" }];
        setLines(firstLines);
        void refreshPreview(orderId, firstLines);
      } catch (cause) {
        setError(messageOf(cause, "编辑页加载失败"));
      } finally {
        setLoading(false);
      }
    })();
  }, [documentType, movementId]);

  /** 行变化后重算预览；orderId 必须显式传入，否则换生产单时会拿旧的单号算预览。 */
  function applyLines(next: SlipLine[], orderId: string = productionOrderId) {
    setLines(next);
    void refreshPreview(orderId, next);
  }

  async function changeOrder(nextOrderId: string) {
    setProductionOrderId(nextOrderId);
    const items = await loadBomFor(nextOrderId);
    applyLines([{ materialId: items[0]?.materialId ?? "", quantity: "1", remark: "" }], nextOrderId);
  }

  /** 添加行：默认选还没有用过的物料；BOM 里的物料都用过了就返回空（强迫用户显式选择，避免重复行）。 */
  function firstUnusedMaterial(current: SlipLine[]) {
    const used = new Set(current.map((line) => `${line.materialId}|${line.supplier_id ?? "__none__"}`));
    return bomMaterialOptions.find((option) => !used.has(`${option.value}|${option.supplier_id ?? "__none__"}`))?.value ?? "";
  }
  /** BOM 里的物料是否都已经有行了：都用完就不能再「添加行」（同一物料 + 同一供应商只能有一行）。 */
  const allMaterialsUsed = bomMaterialOptions.length > 0 && bomMaterialOptions.every((option) => lines.some((line) => line.materialId === option.value && (line.supplier_id ?? "__none__") === (option.supplier_id ?? "__none__")));

  function validate(): string {
    if (!productionOrderId) return "请先选择生产单";
    if (!lines.length) return "请至少添加一行物料";
    if (isReplenishment && !reason.trim()) return "补料必须填写补料原因（坏片/生产失误等）";
    const invalid = lines.find((line) => !line.materialId || !line.quantity || Number(line.quantity) <= 0);
    if (invalid) return "每一行都必须选择物料并填写大于 0 的数量";
    const keys = lines.map((line) => `${line.materialId}|${line.supplier_id ?? "__none__"}`);
    if (new Set(keys).size !== keys.length) return "同一物料 + 同一供应商只能有一行：请合并数量后再保存";
    return "";
  }

  function payload() {
    return {
      production_order_id: productionOrderId,
      ...(isReplenishment ? { reason: reason.trim() } : {}),
      lines: lines.map((line) => ({ material_id: line.materialId, quantity: line.quantity, supplier_id: line.supplier_id ?? undefined, remark: line.remark || undefined })),
    };
  }

  async function save(andSubmit: boolean) {
    const invalid = validate();
    if (invalid) { setError(invalid); return; }
    setError("");
    setBusy(true);
    try {
      const body = payload();
      const saved = editingId
        ? await apiPatch<{ id: string }>(`/production/material-movements/${editingId}`, body)
        : await apiPost<{ id: string }>(createMovementPath(documentType), body as Record<string, unknown>);
      const id = saved.data.id;
      setEditingId(id);
      if (andSubmit) {
        // 提交给仓库（draft → pending_outbound）：这一步不写库存事实，所以不需要幂等键；
        // 重复提交会被服务端按「不是草稿」拒绝，不会造成重复出库。
        await apiPost(`/production/material-movements/${id}/submit`, {});
        notifySuccess(isReplenishment ? "补料单已保存并提交仓库" : "领料单已保存并提交仓库");
      } else {
        notifySuccess(editingId ? "草稿已保存" : (isReplenishment ? "补料单草稿已创建" : "领料单草稿已创建"));
      }
      // 回到列表并保留生产单筛选上下文，用户能立刻看到刚保存的单据。
      window.location.href = productionOrderId ? `${listHref}?production_order_id=${encodeURIComponent(productionOrderId)}` : listHref;
    } catch (cause) {
      notifyError(messageOf(cause, "保存失败"));
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <><PageHeader title={title} /><LoadingState /></>;
  if (blocked) return <><PageHeader title={title} /><ErrorState message={blocked} onRetry={() => window.location.reload()} /><section className="panel panel-body"><Link href={listHref}>返回单据列表</Link></section></>;
  if (error && !orders.length) return <><PageHeader title={title} /><ErrorState message={error} onRetry={() => window.location.reload()} /></>;

  const previewOf = (index: number) => preview?.lines[index];
  const warnings = preview?.warnings ?? [];

  return <>
    <PageHeader title={editingNo ? `${title}（继续编辑 ${editingNo}）` : title} description={isReplenishment ? "坏片、生产失误等造成的补充领料；只绑定生产单，保存并提交仓库后进入「待仓库出库」，仓库确认出库后才计入原料出库并生成补料单（MC-）。" : "领料单只绑定生产单，一个生产单可以开多张；物料只能从该订单 BOM 明细中选择；保存草稿后可随时回来继续编辑，保存并提交仓库后进入「待仓库出库」，等仓库确认出库才扣减原料库存。"}>
      <Button asChild variant="secondary"><Link href={listHref}>返回单据列表</Link></Button>
      <Button asChild variant="ghost"><Link href="/warehouse">返回仓库</Link></Button>
      <Button variant="secondary" data-testid="material-slip-save-draft" onClick={() => void save(false)} disabled={busy}>{busy ? "保存中..." : "保存草稿"}</Button>
      <Button data-testid="material-slip-submit" onClick={() => void save(true)} disabled={busy}>{busy ? "提交中..." : "保存并提交仓库"}</Button>
    </PageHeader>
    {error && <section className="panel panel-body status-error" role="alert">{error}</section>}
    {warnings.length > 0 && <section className="panel panel-body status-warning">{warnings.map((warning) => <p key={warning}>{warning}</p>)}</section>}
    <section className="panel">
      <div className="panel-heading"><h2>单据信息</h2>{editingNo && <span className="panel-note">正在编辑草稿 {editingNo}</span>}</div>
      <div className="panel-body detail-list">
        <label>生产单
          {/* 已经存在的单据不能在编辑页换生产单：PATCH 不接受换单（明细会变成新单的 BOM，单据仍挂在旧单），
              所以编辑态直接锁住，需要换单请新建一张。 */}
          {/* 生产单清单会随下单越来越多（用户 2026-11-13：「所有下拉列表……都要有搜索功能」）：
              带搜索的下拉，按「生产单号 / 订单号」两段都能搜。原来只能滚。
              编辑态照旧锁住（PATCH 不接受换单），disabled 原样透传。 */}
          <SearchableSelect
            id="material-slip-order-select"
            testId="material-slip-order-select"
            value={productionOrderId}
            options={orders.map((order) => ({ value: order.id, label: `${order.productionOrderNo} / ${order.orderNo}` }))}
            placeholder="请选择生产单（仅厂内生产中）"
            label="生产单"
            searchPlaceholder="搜索生产单号或订单号"
            noResultsText="没有匹配的生产单（只列厂内「生产中」的单）"
            disabled={Boolean(editingId)}
            onChange={(value) => void changeOrder(value)}
          />
        </label>
        {editingId && <p className="panel-note">该草稿已绑定当前生产单，不能在这里换单；如需给别的生产单领料，请新建一张。</p>}
        {isReplenishment && <label>补料原因<Input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="例如：伞布原始坏片" /></label>}
        {!bomMaterialOptions.length && <p className="status-warning">该生产单订单的 BOM 没有明细，无法选择物料：请先在订单 BOM 里维护用料。</p>}
      </div>
    </section>
    <section className="panel material-slip-editor" data-testid="material-slip-lines">
      <div className="panel-heading"><h2>物料明细</h2><div className="page-actions"><Button variant="secondary" data-testid="material-slip-add-line" disabled={allMaterialsUsed} title={allMaterialsUsed ? "该订单 BOM 里的物料都已登记，同一物料只能有一行" : undefined} onClick={() => applyLines([...lines, { materialId: firstUnusedMaterial(lines), quantity: "1", remark: "" }])}>添加行</Button></div></div>
      <div className="panel-body">
        <div className="table-wrap">
          <Table className="data-table">
            <TableHeader><TableRow>
              <TableHead className="slip-col-material">物料</TableHead>
              <TableHead>物料代码</TableHead>
              <TableHead>型号</TableHead>
              <TableHead>颜色</TableHead>
              <TableHead>单位</TableHead>
              <TableHead>供应商</TableHead>
              {/* 「配料数量 / 已领数量 / 本次领料量 / 余下数量」与领料单打印件的列一一对应、
                  同名同值（口径由后端 material-slip-quantity 统一算，页面只显示）：
                  车间拿打印件核对系统时，两边是同一组数字，不再一边含本单、一边不含本单。 */}
              <TableHead>配料数量</TableHead>
              {!isReplenishment && <TableHead>已领数量</TableHead>}
              <TableHead className="slip-col-qty">{isReplenishment ? "补领数量" : "本次领料量"}</TableHead>
              {!isReplenishment && <TableHead>余下数量</TableHead>}
              <TableHead>当前库存量</TableHead>
              {!isReplenishment && <><TableHead>采购入库数量</TableHead><TableHead>采购未入库数量</TableHead></>}
              <TableHead className="slip-col-remark">备注</TableHead>
              <TableHead className="slip-col-action">操作</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {lines.length ? lines.map((line, index) => {
                const info = previewOf(index);
                // 补料单没有 issue-preview（预览必为 null），库存是否够只能按原料余额判断；
                // 余额没加载出来时不标红，避免「整列红色」的误报。
                const stock = rawBalances.filter((balance) => balance.material_id === line.materialId).reduce((sum, balance) => sum + Number(balance.quantity || 0), 0);
                const short = isReplenishment
                  ? rawBalances.length > 0 && stock < Number(line.quantity || 0)
                  : Boolean(info) && Number(info?.available_before ?? info?.inventory_quantity ?? 0) < Number(line.quantity || 0);
                const update = (patch: Partial<SlipLine>) => applyLines(lines.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item));
                // 四个数量直接取后端算好的值（与打印件同一口径）；接口没返回时回落到旧字段，避免整列空白。
                const materialQuantity = info?.material_quantity ?? info?.approved_usage ?? info?.bom_reference_quantity ?? "-";
                const issuedQuantity = info?.issued_quantity ?? info?.cumulative_issued_before ?? "-";
                const remainingQuantity = info?.remaining_quantity;
                const remainingText = remainingQuantity === null || remainingQuantity === undefined ? "-" : String(remainingQuantity);
                const supplierOption = line.supplier_id ? bomItems.find((b) => b.supplierId === line.supplier_id && b.materialId === line.materialId) : null;
                const supplierLabel = line.supplier_id ? (supplierOption?.supplierName ?? "未指定") : "未指定";
                const availableStock = info?.available_before ?? "-";
                return <TableRow key={`${line.materialId || "new"}-${line.supplier_id ?? "__none__"}-${index}`}>
                  <TableCell className="slip-col-material" title={materialLabel(line.materialId)}>
                    {/* 原料来自该订单的 BOM 明细，几十个部件时靠滚找同样费劲（用户 2026-11-13：
                        「所有下拉列表……都要有搜索功能」）。BOM 为空时给一条说明原因的占位项，
                        与原来那条 disabled 占位同一目的：不能静默变成一个空下拉。 */}
                    <SearchableSelect
                      testId={`material-slip-line-material-${index}`}
                      value={line.materialId}
                      options={bomMaterialOptions.length
                        ? bomMaterialOptions.map((option) => ({ value: option.value, label: option.label }))
                        : [{ value: "__none__", label: "该生产单订单的 BOM 表没有明细" }]}
                      placeholder="选择原料"
                      label="原料"
                      searchPlaceholder="搜索物料编码、名称、规格或颜色"
                      noResultsText="没有匹配的原料（只列该订单 BOM 里的部件）"
                      onChange={(value) => update({ materialId: value })}
                    />
                  </TableCell>
                  <TableCell title={info?.material_code ?? "-"}>{info?.material_code ?? "-"}</TableCell>
                  <TableCell title={info?.model ?? "-"}>{info?.model ?? "-"}</TableCell>
                  <TableCell title={info?.color ?? "-"}>{info?.color ?? "-"}</TableCell>
                  <TableCell>{unitOf(line.materialId)}</TableCell>
                  <TableCell title={supplierLabel}>{supplierLabel}</TableCell>
                  <TableCell>{materialQuantity}</TableCell>
                  {!isReplenishment && <TableCell>{issuedQuantity}</TableCell>}
                  <TableCell className="slip-col-qty"><Input type="number" min="0" step="0.0001" data-testid={`material-slip-line-quantity-${index}`} value={line.quantity} onChange={(event) => update({ quantity: event.target.value })} /></TableCell>
                  {/* 余下数量为负 = 超领：跟打印件一样显示负数，并标红提示，不抹成 0。 */}
                  {!isReplenishment && <TableCell className={typeof remainingQuantity === "number" && remainingQuantity < 0 ? "status-danger" : undefined}>{remainingText}</TableCell>}
                  <TableCell className={short ? "status-danger" : "status-success"} title={supplierStockOf(line.materialId) || (isReplenishment ? balanceOf(line.materialId) : availableStock)}>{isReplenishment ? balanceOf(line.materialId) : availableStock}</TableCell>
                  {!isReplenishment && <><TableCell>{info?.purchase_received_quantity ?? "-"}</TableCell><TableCell>{info?.purchase_outstanding_quantity ?? "-"}</TableCell></>}
                  <TableCell className="slip-col-remark"><Input value={line.remark} placeholder="可选" onChange={(event) => update({ remark: event.target.value })} /></TableCell>
                  <TableCell className="slip-col-action"><Button size="sm" variant="ghost" title="删除行" aria-label="删除行" onClick={() => applyLines(lines.filter((_, itemIndex) => itemIndex !== index))}>删除</Button></TableCell>
                </TableRow>;
              }) : <TableRow><TableCell colSpan={isReplenishment ? 11 : 15}><EmptyState title="还没有明细" description="点右上角「添加行」开始登记物料。" /></TableCell></TableRow>}
            </TableBody>
          </Table>
        </div>
      </div>
    </section>
  </>;
}
