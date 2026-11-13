"use client";

// 采购计划详情/编辑（2026-09-27）。
//
// 用户原话：「在采购计划里面，每个销售单对应一份的BOM对应一份的采购计划。还要加上供应商，
// 供应商地址，联系人这些column。然后根据供应商收束下单，下单到采购单模块。」

// 这一页是**唯一**改"数量/单价/供应商"的地方（口径 7）：采购单页只剩打印信息，
// 因为两个模块都能改数量，同一批货就有两份数字，「这张 BOM 还差什么没买」立刻失真。
//
// 三条会让人踩坑、所以写在最上面的约定：
//   1. **14 列一次展示、不横向滚动**（口径 5）：列宽由 `.plan-col-*` 写死、和正好 100%，
//      只读文本列用 `.plan-cell-ellipsis` + 原生 title 看全文；编辑格**不**做省略号
//      （对输入框做省略没有意义，它本来就能横向滚动看全）。
//   2. **已下单的行留在表里**（口径 6），但内容列只读、不能删。
//      两个例外：预计到货**可以改**（它是"预期"不是既成事实，而且采购单页的明细编辑已经关掉，
//      这里是它唯一的通路；保存后服务端会同步进那张采购明细），行序可重排。
//   3. 地址/联系人是**只读派生**（口径 4）：来自选中的那家供应商主数据，不写进行状态。
import { useCallback, useEffect, useMemo, useState } from "react";
import { Trash2 } from "lucide-react";
import { ActionDialog } from "../ui/action-dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { SearchableSelect } from "../ui/searchable-select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "../ui/sheet";
import { SupplierSelect, type BomSupplierRef } from "../bom/supplier-select";
import { notifyError, notifySuccess } from "../ui/toaster";
import { ApiClientError, apiGet, apiPost, apiRequest } from "../../lib/api-client";
import { fetchCurrencyOptions, type CurrencyOption } from "../../lib/currency-catalogue";
import { amountSummaryText, lineAmountText, sumPlanAmounts, DEFAULT_PLAN_CURRENCY, type PlanAmount } from "../../lib/purchase-plan-amount";
import { importBomPrices, mergeBomReferences, pendingPriceIndexes, priceImportSummary, trimPlanNumber, type PriceImportOutcome } from "../../lib/purchase-plan-price-entry";
import { shouldRefreshOnVisibility } from "../../lib/refresh-policy";
import { PlanOrderPreview, groupPlanRows, type PlanDraftRow } from "./plan-order-preview";
import { PlanPriceDialog } from "./plan-price-dialog";

export type PlanMaterialRef = { id: string; materialCode?: string; code?: string; name?: string; isActive?: boolean; defaultUnitId?: string };
export type PlanUnitRef = { id: string; name?: string; isActive?: boolean };
/** 下拉选项。`disabled` 只用来显示「这一行选中的值已经不在池子里」（见 `materialOptionsOf`）。 */
type PlanOption = { value: string; label: string; disabled?: boolean };

type PlanItem = {
  id: string;
  materialId: string;
  materialName: string;
  materialCode?: string | null;
  model?: string | null;
  unitId: string;
  unitName?: string | null;
  quantity: string;
  unitPrice: string;
  /** 行总价（服务端派生：数量 × 单价）。表里显示的是**本地即时算**的那一个，见 `lineAmountText`。 */
  amount?: string | null;
  /** 这一行单价的币种：未下单是默认人民币，下单时按供应商组写回（见后端模型注释）。 */
  currency?: string | null;
  /**
   * BOM 表上这个物料的**参考单价**（2026-10-08 第二轮）。
   *
   * 为什么计划详情要下发它：计划是**建立时的快照**，BOM 之后填的价不会回头进已有计划 ——
   * 于是"先建计划、后去 BOM 填价"的人永远看到 0 价、下不了单（用户原话：「为什么BOM表保存了单价之后，
   * 采购计划显示不了单价，下单不了」）。它只用于**单价还是 0 的未下单行**的预填，落库仍只在保存计划时。
   */
  bomReferenceUnitPrice?: string | null;
  bomReferenceCurrency?: string | null;
  bomItemId?: string | null;
  supplierId?: string | null;
  supplierName?: string | null;
  supplierAddress?: string | null;
  supplierContact?: string | null;
  expectedDate?: string | null;
  purchaseOrderItemId?: string | null;
  purchaseOrderNo?: string | null;
  extensionData?: Record<string, unknown> | null;
};
export type PlanDetail = {
  id: string; planNo: string; orderNo: string; itemNo?: string | null; customerName?: string | null;
  bomId: string; bomVersion?: number | null; status: string; statusLabel: string;
  lineCount: number; unorderedCount: number; orderedCount: number;
  /** 计划合计（按币种分列）与「其中未下单」——服务端口径。表下方那一行以本地即时算的为准（正在编辑）。 */
  amounts?: PlanAmount[]; unorderedAmounts?: PlanAmount[];
  bomDeleted?: boolean; bomExtraMaterialCount?: number; deliveryDate?: string | null;
  /** 所属销售单已被软删（2026-11-03）：计划不删，只标成「孤立」。判定只认后端字段。 */
  orphaned?: boolean;
  updatedAt: string; items: PlanItem[];
  /**
   * 这份计划下**还能并入**的采购单（2026-10-13 口径 6）：`{id, purchaseOrderNo, supplierId, currency, itemCount, totalAmount}`。
   * 收束预览按它把「这一组会并到哪张单 / 会新建一张」写出来 —— 自动收束有四条判据，
   * 所以它**有时候并不了**，而"以为收束了、其实多出一张单"是最难查的一类坏。
   */
  openPurchaseOrders?: Array<{ id: string; purchaseOrderNo: string; supplierId: string | null; currency: string; itemCount: number; totalAmount: string }>;
};
/** 一行 BOM 明细的累计下单情况（`GET /purchase-orders/bom-item-status`）。字段名是历史原因，见后端注释。 */
type BomItemOrderStatus = { bom_item_id: string; required_quantity: string; ordered_quantity: string; draft_quantity: string; state: "none" | "draft" | "partial" | "ordered"; ordered_purchase_order_nos: string[]; draft_purchase_order_nos: string[] };

const messageOf = (cause: unknown, fallback: string) => (cause instanceof ApiClientError ? cause.message : fallback);
/** 冲突要认**错误码**而不是文案（文案会变，码是契约）。 */
const errorCodeOf = (cause: unknown) => (cause instanceof ApiClientError ? cause.code : undefined);
/**
 * 数字的显示形式（`10.0000` → `10`）。实现只有一处：`lib/purchase-plan-price-entry.ts` 的
 * `trimPlanNumber`（那边有用例钉着「只在**小数点之后**剥零」—— 就地写的 `replace(/0+$/, "")`
 * 会把 `"10"` 剥成 `"1"`）。这里留个短名，免得 7 处调用点都要跟着改。
 */
const trimQuantity = trimPlanNumber;
const toDateInput = (value?: string | null) => (value ? String(value).slice(0, 10) : "");

/**
 * 下单结果的一句话（2026-10-13 自动收束）：落点有两种，必须**分开说**。
 *
 * 「并进了那张单」与「新建了一张单」对采购员是两件不同的事 —— 前者供应商手上那张单会多两行
 * （要跟对方说一声），后者是另一份凭证要发出去。合成一句"下了 N 张"会把这两件事藏起来。
 */
function orderOutcomeText(orders: Array<{ purchaseOrderNo: string; merged?: boolean; lineCount?: number }>) {
  const merged = orders.filter((order) => order.merged);
  const fresh = orders.filter((order) => !order.merged);
  const parts: string[] = [];
  if (merged.length) parts.push(`并入 ${merged.map((order) => `${order.purchaseOrderNo}（${order.lineCount ?? 0} 行）`).join("、")}`);
  if (fresh.length) parts.push(`新建 ${fresh.map((order) => order.purchaseOrderNo).join("、")}`);
  return parts.join("；") || "没有落成任何采购单";
}

export function PlanDetailSheet({ planId, materials, units, onClose, onSaved, onDeleted }: {
  planId: string;
  materials: PlanMaterialRef[];
  units: PlanUnitRef[];
  onClose: () => void;
  /** 保存/下单之后：让列表页刷新。 */
  onSaved: () => void;
  /** 计划被删除：关掉 Sheet 并刷新列表。 */
  onDeleted: () => void;
}) {
  const [plan, setPlan] = useState<PlanDetail | null>(null);
  const [rows, setRows] = useState<PlanDraftRow[]>([]);
  const [selected, setSelected] = useState<number[]>([]);
  const [orderStatus, setOrderStatus] = useState<Record<string, BomItemOrderStatus>>({});
  const [stock, setStock] = useState<Record<string, string>>({});
  const [suppliers, setSuppliers] = useState<BomSupplierRef[]>([]);
  const [currencies, setCurrencies] = useState<CurrencyOption[]>([]);
  const [groupCurrency, setGroupCurrency] = useState<Record<string, string>>({});
  const [outsideBomReason, setOutsideBomReason] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  /** 乐观锁冲突：**保留本地改动**，只给一个"重新加载（放弃本次修改）"的入口（照 BOM 工作区写法）。 */
  const [conflict, setConflict] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  /**
   * 「填单价」浮层（2026-10-09，用户：「我真没看到哪里可以手填单价的。可以重新设计这一块」）。
   * 它改的是**同一份 rows 状态**，所以关掉浮层表里那一格也变了。
   */
  const [priceDialog, setPriceDialog] = useState(false);
  /** 上一次「导入 BOM 参考单价」的结果（给浮层里那句结果文案用）。 */
  const [priceImport, setPriceImport] = useState<PriceImportOutcome | null>(null);
  /**
   * 收束下单时「有行会被留下」的复核：勾选里含还没填单价的行时先弹一次，
   * 说清**哪几行不下单、留在计划里**（行号存下来只是为了在弹窗里点名）。取消 = 一个请求都不发。
   *
   * 2026-10-11 起 0 价的行不再是"确认后可以一起下"，而是**排除在本次下单之外**。
   */
  const [holdBackConfirm, setHoldBackConfirm] = useState<number[] | null>(null);

  const materialOptions = useMemo<PlanOption[]>(() => materials.filter((item) => item.isActive !== false).map((item) => ({ value: item.id, label: `${item.materialCode ?? item.code ?? ""} / ${item.name ?? "物料"}` })), [materials]);
  const unitOptions = useMemo<PlanOption[]>(() => units.filter((item) => item.isActive !== false).map((item) => ({ value: item.id, label: item.name ?? item.id })), [units]);
  const poolMaterialIds = useMemo(() => new Set(materialOptions.map((option) => option.value)), [materialOptions]);
  const poolUnitIds = useMemo(() => new Set(unitOptions.map((option) => option.value)), [unitOptions]);
  const supplierNameOf = useCallback((id: string) => suppliers.find((item) => item.id === id)?.name ?? "供应商", [suppliers]);

  /**
   * 这一行真正要显示的选项 = 物料池 + **这一行自己那个值**。
   *
   * 为什么必须补上后者（用户 2026-09-30：「有的地方没有显示相应的采购物料」）：
   * 物料被停用 / 软删 / 改成成品之后就不再出现在 `GET /materials` 里，而 Radix 的 `SelectValue`
   * 只在**选项列表里找得到**对应项时才显示文字 —— 找不到就退回占位符「请选择物料」。
   * 于是计划里明明记着物料的那一格看起来是空的，像"这份计划漏了这个部件"。
   * 服务端（`purchase-plans.service.ts` 的 `get()`）已经为此把物料名从快照里兜回来
   * （`materialName: item.material?.name ?? snapshotName(item.materialSnapshot)`），前端不能把它丢掉。
   *
   * 补进来的这一项是 `disabled`：名字要显示（选中的项即使是 disabled，Radix 仍会把它的文字
   * 放进触发框），但**不能再被选到别的行上** —— 真选了服务端也会以「物料不存在或已停用」
   * 拒绝整份计划，那是个只有撞上才知道原因的错。
   */
  function materialOptionsOf(row: PlanDraftRow): PlanOption[] {
    if (!row.materialId || poolMaterialIds.has(row.materialId)) return materialOptions;
    return [{ value: row.materialId, label: `${row.materialCode ? `${row.materialCode} / ` : ""}${row.materialName || "物料"}（不在物料池）`, disabled: true }, ...materialOptions];
  }
  /** 单位同理：单位被停用后不在 `GET /units` 的可用项里，那一格会退化成一个空的「单位」。 */
  function unitOptionsOf(row: PlanDraftRow): PlanOption[] {
    if (!row.unitId || poolUnitIds.has(row.unitId)) return unitOptions;
    return [{ value: row.unitId, label: `${row.unitName || "单位"}（不在单位池）`, disabled: true }, ...unitOptions];
  }

  const load = useCallback(async () => {
    setError("");
    try {
      const result = await apiGet<PlanDetail>(`/purchase-plans/${planId}`);
      const detail = result.data;
      setPlan(detail);
      /**
       * BOM 参考单价回填（2026-10-08 第二轮）。
       *
       * 背景：计划的明细是**建立时的快照**（口径 12：BOM 后来加物料也不自动插行），所以报价后来才填进
       * BOM 的话，已有计划永远停在 0 价 —— 而 0 价不能下单。用户就是这么被卡住的。
       *
       * 取三条同时成立才预填：
       *   ① **未下单**（已下单的行在服务端被硬锁，预填等于制造一次注定被拒的保存）；
       *   ② **单价还是 0**（谈过价的行绝不动：那才是"跟供应商谈定了什么"）；
       *   ③ **BOM 上确实有 > 0 的参考价**。
       * 预填只写进**界面状态**（`priceFromBom` 标记出来源，用户一改就清掉），
       * **点「保存计划」才落库** —— 与"不猜价格"的口径不冲突：这个价是采购员自己填在 BOM 上的。
       */
      setRows(detail.items.map((item) => {
        const ordered = Boolean(item.purchaseOrderItemId);
        const unitPrice = trimQuantity(item.unitPrice);
        const reference = item.bomReferenceUnitPrice ? trimQuantity(item.bomReferenceUnitPrice) : "";
        const fromBom = !ordered && Number(unitPrice) === 0 && Number(reference) > 0;
        return {
          id: item.id,
          materialId: item.materialId,
          materialName: item.materialName,
          materialCode: item.materialCode ?? "",
          model: item.model ?? "",
          quantity: trimQuantity(item.quantity),
          unitId: item.unitId,
          unitName: item.unitName ?? "",
          unitPrice: fromBom ? reference : unitPrice,
          // 币种跟着这一格里的价走：预填的是 BOM 上那笔价（可能是美元），留着人民币会算错合计。
          currency: fromBom ? (item.bomReferenceCurrency ?? DEFAULT_PLAN_CURRENCY) : item.currency ?? DEFAULT_PLAN_CURRENCY,
          priceFromBom: fromBom,
          bomReferenceUnitPrice: item.bomReferenceUnitPrice ?? null,
          bomReferenceCurrency: item.bomReferenceCurrency ?? null,
          supplierId: item.supplierId ?? "",
          ordered,
          purchaseOrderNo: item.purchaseOrderNo ?? null,
          bomItemId: item.bomItemId ?? null,
          expectedDate: toDateInput(item.expectedDate),
          supplierAddress: item.supplierAddress ?? null,
          supplierContact: item.supplierContact ?? null,
          extensionData: item.extensionData ?? null,
        };
      }));
      // 默认全选**未下单**的行：采购员多数时候就是"都买"，少数例外才需要取消勾选。
      // 已下单的行不参与（它们已经落在某张单上了）。
      setSelected(detail.items.flatMap((item, index) => (item.purchaseOrderItemId ? [] : [index])));
      setOutsideBomReason(String((detail.items.find((item) => item.extensionData?.outside_bom_reason)?.extensionData?.outside_bom_reason) ?? ""));
      setConflict("");
      if (detail.bomId) await refreshOrderStatus(detail.bomId);
      await refreshStock(detail.items.map((item) => item.materialId));
    } catch (cause) {
      setError(messageOf(cause, "采购计划加载失败"));
    } finally {
      setLoading(false);
    }
  }, [planId]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { let cancelled = false; void fetchCurrencyOptions().then((options) => { if (!cancelled) setCurrencies(options); }); return () => { cancelled = true; }; }, []);
  // 供应商池由本组件自己加载（与 BOM 工作区同一做法）：取不到就退化成空池，
  // 不影响已有行上的供应商名（那来自计划详情里的快照）。
  useEffect(() => {
    let cancelled = false;
    void apiGet<BomSupplierRef[]>("/suppliers").then((result) => { if (!cancelled) setSuppliers(result.data ?? []); }).catch(() => { /* 供应商池拿不到不阻断计划编辑 */ });
    return () => { cancelled = true; };
  }, []);

  /**
   * 「下单状态」是**累计**口径：同一个 BOM 行可能被其它计划/其它采购单覆盖过。
   * 这一列存在的意义就是防止重复采购，所以它跟着窗口焦点一起刷新
   * （同事或另一个窗口刚下的单，本页要能看见）。
   */
  async function refreshOrderStatus(bomId: string) {
    try {
      const result = await apiGet<BomItemOrderStatus[]>(`/purchase-orders/bom-item-status?bom_id=${encodeURIComponent(bomId)}`);
      setOrderStatus(Object.fromEntries(result.data.map((row) => [row.bom_item_id, row])));
    } catch { /* 状态拿不到就不显示状态，不阻断编辑 */ }
  }
  async function refreshStock(materialIds: string[]) {
    const ids = [...new Set(materialIds.filter(Boolean))];
    if (!ids.length) return;
    try {
      const result = await apiGet<Array<{ material_id: string; unit_id: string; quantity: string }>>(`/inventory/raw-material-balances?material_ids=${ids.join(",")}`);
      // 只按「物料 + 单位」存：同一物料的米与卷不可相加（数量不跨单位合计）。
      setStock(Object.fromEntries(result.data.map((item) => [`${item.material_id}|${item.unit_id}`, item.quantity])));
    } catch { /* 库存是决策支持，取不到不阻断 */ }
  }
  useEffect(() => {
    const refresh = () => { if (shouldRefreshOnVisibility(document.visibilityState) && plan?.bomId) void refreshOrderStatus(plan.bomId); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => { window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [plan?.bomId]);

  const stockFor = (materialId: string, unitId: string) => stock[`${materialId}|${unitId}`] ?? "0";
  /** 同一物料在**其它单位**上的余额：单位不同不可相加，只能作为提示（沿用采购单页的口径）。 */
  function otherUnitStock(materialId: string, unitId: string) {
    const prefix = `${materialId}|`;
    return Object.entries(stock)
      .filter(([key, quantity]) => key.startsWith(prefix) && key !== `${materialId}|${unitId}` && Number(quantity) !== 0)
      .map(([key, quantity]) => `${quantity} ${units.find((item) => item.id === key.slice(prefix.length))?.name ?? "其它单位"}`)
      .join("、");
  }

  function updateRow(index: number, patch: Partial<PlanDraftRow>) { setRows((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row))); }
  /**
   * 「导入 BOM 参考单价」：只填空的未下单行 —— 手填过的价与已下单的行一律不动。
   *
   * 先**重新取一次详情**再导：BOM 上的参考价可能是这份计划打开之后才填的（比如采购员去 BOM 表
   * 补了价再回来点这个按钮）—— 只拿内存里那份数据，"导入"就等于什么都没做。
   * 合并时**只并参考单价两个字段**，绝不动用户已经改过的数量/单价/供应商（那次请求是只读的）。
   * 判据与结果文案都在 `lib/purchase-plan-price-entry.ts`（有用例逐条钉着"哪些行不许被碰"）。
   */
  async function importBomPricesIntoRows() {
    setBusy("import-price");
    setError("");
    try {
      const result = await apiGet<PlanDetail>(`/purchase-plans/${planId}`);
      const merged = mergeBomReferences(rows, result.data.items);
      const outcome = importBomPrices(merged);
      const patchByIndex = new Map(outcome.patches.map((patch) => [patch.index, patch]));
      setRows(merged.map((row, index) => {
        const patch = patchByIndex.get(index);
        if (!patch) return row;
        // 币种跟着这笔参考价走（BOM 上没写币种时沿用这一行原来的），否则合计会按错的币种算。
        return { ...row, unitPrice: patch.unitPrice, currency: patch.currency ?? row.currency ?? DEFAULT_PLAN_CURRENCY, priceFromBom: true };
      }));
      setPriceImport(outcome);
      if (outcome.filled) notifySuccess(priceImportSummary(outcome));
      else notifyError(priceImportSummary(outcome));
    } catch (cause) {
      notifyError(messageOf(cause, "导入 BOM 参考单价失败"));
    } finally { setBusy(""); }
  }
  function toggleRow(index: number) { setSelected((current) => (current.includes(index) ? current.filter((i) => i !== index) : [...current, index])); }
  function toggleAll(checked: boolean) {
    // 全选不含已下单行（它们已经落在某张单上了）。
    setSelected(checked ? rows.flatMap((row, index) => (row.ordered ? [] : [index])) : []);
  }
  function addRow() {
    const material = materials.find((item) => item.isActive !== false);
    const unitId = material?.defaultUnitId ?? "";
    setRows((current) => [...current, { materialId: material?.id ?? "", materialName: material?.name ?? "", model: "", quantity: "1", unitId, unitName: units.find((item) => item.id === unitId)?.name ?? "", unitPrice: "0", currency: DEFAULT_PLAN_CURRENCY, supplierId: "", ordered: false, expectedDate: "", currentStock: stockFor(material?.id ?? "", unitId) }]);
    // 新加的行默认**勾上**：刚加一行本来就是"打算买"，不勾的话下一步「收束下单」会静默漏掉它 ——
    // 与"默认全选未下单行"是同一条思路。
    setSelected((current) => [...current, rows.length]);
  }
  function removeSelected() {
    if (!selected.length) { setError("请先勾选要移除的行"); return; }
    const blocked = selected.filter((index) => rows[index]?.ordered);
    if (blocked.length) { setError(`有 ${blocked.length} 行已经下过单，不能从计划里移除；要改先「退回采购计划」`); return; }
    setRows((current) => current.filter((_, index) => !selected.includes(index)));
    setSelected([]);
  }
  function changeMaterial(index: number, materialId: string) {
    const material = materials.find((item) => item.id === materialId);
    const row = rows[index];
    // 换掉物料之后这一行就不再是 BOM 上那一行：`bom_item_id` 必须一起清掉，
    // 否则后端以 PURCHASE_BOM_ITEM_MISMATCH 拒绝**整份计划**（而报错看不出是哪一行）。
    // 判据是**物料 id 变了**，不是"名字变了" —— 名字相同但其实是另一个物料时同样要清。
    const keepBom = row?.bomItemId && row.materialId !== materialId ? { bomItemId: null } : {};
    updateRow(index, { materialId, materialName: material?.name ?? "", materialCode: material?.materialCode ?? material?.code ?? "", unitId: material?.defaultUnitId ?? row?.unitId ?? "", unitName: units.find((item) => item.id === (material?.defaultUnitId ?? row?.unitId))?.name ?? "", ...keepBom });
  }

  const outsideBomRows = rows.filter((row) => !row.bomItemId);
  /**
   * 从 BOM 参考单价预填过来、**还没保存**的行。
   *
   * 面板上必须说清这件事：单价本来都是 0，一打开计划却有了数，不说来源就会被当成"供应商报价"。
   * （用户 2026-10-08 的原话就是「BOM表保存了单价之后，采购计划显示不了单价，下单不了」——
   * 这条说明就是把那个疑问的答案摆在页面上。）
   */
  const fromBomRows = rows.filter((row) => row.priceFromBom);
  /**
   * 还没填单价的行号（0 或空）。状态条、填价浮层与下单确认共用这**一个**判据
   * （实现与用例在 lib/purchase-plan-price-entry.ts）—— 三处各写一遍 `Number(...) > 0`
   * 早晚会漂成"状态条说还有 2 行、下单却放过了"。
   */
  const pendingPriceIndexesOfRows = pendingPriceIndexes(rows);
  const needsOutsideBomReason = outsideBomRows.length > 0;
  const selectedRows = rows.filter((_, index) => selected.includes(index));
  /**
   * 复核后确认：下单请求**只包含有单价的行**。
   *
   * 2026-10-11 用户改了口径：「确定单价的能下单，没确定单价的先不下单」。
   * 所以勾选集合里那些还没填单价的行**不进本次请求** —— 它们留在计划里，
   * 补上单价之后再下一波（分批下单本来就是采购现实）。
   *
   * 服务端同一道门也在（`PURCHASE_PLAN_PRICE_REQUIRED`）：即使有请求硬把 0 价行塞进去，
   * 也会被那一格拦住，而不是变成一张 0 元采购单 → 0 元应付（财务收到一张没法付的单）。
   */
  const orderableRows = rows.filter((row) => Number(row.unitPrice) > 0);
  const placedRows = useMemo(() => selectedRows.filter((row) => Number(row.unitPrice) > 0), [selectedRows]);
  const placedGroups = useMemo(() => groupPlanRows(placedRows, supplierNameOf), [placedRows, supplierNameOf]);
  const heldBackRowNos = rows.flatMap((row, index) => (selected.includes(index) && !(Number(row.unitPrice) > 0) ? [index + 1] : []));
  const currencyOf = useCallback((supplierId: string) => groupCurrency[supplierId] ?? "CNY", [groupCurrency]);
  /**
   * 合计**本地即时算**（用户一边改单价一边要看钱），口径与后端 `sumPlanAmounts` 完全一致
   * （同一组向量钉在 `lib/purchase-plan-amount.test.mjs` 与 API 单测里）。
   * 不用服务端返回的 `plan.amounts`：那是**上次保存时**的数，正在编辑的这一屏会与它不一致。
   */
  const planAmounts = useMemo(() => sumPlanAmounts(rows), [rows]);
  const unorderedAmounts = useMemo(() => sumPlanAmounts(rows.filter((row) => !row.ordered)), [rows]);

  /** 保存的请求体：整体替换行。已下单行的内容由服务端锁住（只允许序号与预计到货）。 */
  function itemsPayload() {
    return rows.map((row) => ({
      id: row.id,
      material_id: row.materialId,
      unit_id: row.unitId,
      bom_item_id: row.bomItemId ?? undefined,
      supplier_id: row.supplierId || undefined,
      model: row.model || undefined,
      quantity: row.quantity,
      unit_price: row.unitPrice,
      expected_date: row.expectedDate ? new Date(row.expectedDate).toISOString() : undefined,
      // BOM 外的补料/替代料必须带原因（与采购单 `refs()` 同一条规则，服务端也拦）。
      extension_data: row.bomItemId ? (row.extensionData ?? undefined) : { ...(row.extensionData ?? {}), outside_bom_reason: outsideBomReason.trim() },
    }));
  }
  function validate(): string {
    if (!rows.length) return "计划里一行都没有：先在 BOM 表里补明细，或点「添加行」";
    const incomplete = rows.findIndex((row) => !row.materialId || !row.unitId || !row.quantity || row.unitPrice === "");
    if (incomplete >= 0) return `第 ${incomplete + 1} 行请补齐物料/单位/数量/单价`;
    if (needsOutsideBomReason && !outsideBomReason.trim()) return `有 ${outsideBomRows.length} 行不在 BOM 表中（补料/替代料），请填写「BOM 外新增原因」`;
    return "";
  }

  async function save() {
    const invalid = validate();
    if (invalid) { setError(invalid); return; }
    setBusy("save"); setError("");
    try {
      await apiRequest(`/purchase-plans/${planId}`, { method: "PATCH", body: JSON.stringify({ expected_updated_at: plan?.updatedAt, items: itemsPayload() }) });
      notifySuccess("采购计划已保存");
      await load();
      onSaved();
    } catch (cause) {
      const code = errorCodeOf(cause);
      if (code === "PURCHASE_PLAN_UPDATE_CONFLICT") setConflict(messageOf(cause, "这份计划已被他人修改"));
      else setError(messageOf(cause, "采购计划保存失败"));
    } finally { setBusy(""); }
  }

  /**
   * 点「收束下单」时先做**本地**校验，再决定是直接下单还是先复核。
   *
   * 0 价的行不再是「要么拦住、要么确认放行」的二选一，而是**排除在本次下单之外**：
   * 它们留在计划里（`heldBackRowNos` 会点名是哪几行），补价之后再下一波。
   * 所以这里不再有"放行开关"，只有「先复核一下少了哪几行」。
   */
  async function order() {
    setError("");
    if (selectedRows.some((row) => !row.id)) { setError("有还没保存过的新行：请先「保存计划」，再收束下单"); return; }
    if (!selectedRows.length) { setError("还没有勾选任何一行"); return; }
    if (!placedRows.length) {
      // 勾中的行全都没价 —— 这时说清「先去填单价」，而不是报一句"没有选供应商"（那是另一个问题）
      setError(`勾选的 ${heldBackRowNos.length} 行都还没有单价（第 ${heldBackRowNos.join("、")} 行）：先点「填单价」填上，再下单`);
      return;
    }
    if (!orderableRows.length || placedGroups.every((group) => !group.supplierId)) {
      setError("还没有任何一行选了供应商");
      return;
    }
    if (placedGroups.some((group) => !group.supplierId)) { setError("有行还没选供应商，不能下单（一个供应商一张单）"); return; }
    // 有行会被留下（勾中但没单价）：先复核一下，确认后**只下有单价的那几行**
    if (heldBackRowNos.length) { setHoldBackConfirm(heldBackRowNos); return; }
    await placeOrder();
  }

  /**
   * 真正发下单请求。**请求里只有有单价的行**（0 价的行留在计划里，服务端也会拒）。
   */
  async function placeOrder() {
    setError("");
    setHoldBackConfirm(null);
    const assigned = placedGroups.filter((group) => group.supplierId);
    if (!assigned.length) { setError("还没有任何一行选了供应商"); return; }
    setBusy("order");
    try {
      const result = await apiPost<{ orders: Array<{ purchaseOrderNo: string; merged?: boolean; lineCount?: number }> }>(`/purchase-plans/${planId}/order`, {
        purchase_date: new Date().toISOString(),
        groups: assigned.map((group) => ({
          supplier_id: group.supplierId,
          currency: currencyOf(group.supplierId),
          items: group.rows.flatMap((row) => (row.id ? [row.id] : [])),
        })),
      });
      const orders = result.data?.orders ?? [];
      const held = heldBackRowNos.length ? `；第 ${heldBackRowNos.join("、")} 行没单价，留在计划里` : "";
      notifySuccess(`已按供应商收束下单 ${placedRows.length} 行：${orderOutcomeText(orders)}${held}`);
      await load();
      onSaved();
    } catch (cause) {
      setError(messageOf(cause, "收束下单失败"));
    } finally { setBusy(""); }
  }

  async function removePlan() {
    setBusy("delete");
    try {
      await apiRequest(`/purchase-plans/${planId}`, { method: "DELETE" });
      notifySuccess("采购计划已删除");
      setConfirmDelete(false);
      onDeleted();
    } catch (cause) {
      setError(messageOf(cause, "删除失败"));
      setConfirmDelete(false);
    } finally { setBusy(""); }
  }

  /** 已下单行落在哪张单上。 */
  function orderedCell(row: PlanDraftRow) {
    if (!row.ordered) return null;
    return <span className="status-success" title={`已下单：${row.purchaseOrderNo ?? ""}`}>{row.purchaseOrderNo ?? "已下单"}</span>;
  }
  /** 「下单状态」= 这个 BOM 行在这张 BOM 上的**累计**情况（口径 13）。 */
  function orderStatusCell(row: PlanDraftRow) {
    if (!row.bomItemId) return <span className="panel-note">BOM 外新增</span>;
    const status = orderStatus[row.bomItemId];
    if (!status || status.state === "none") return <span className="panel-note">未下单</span>;
    if (status.state === "draft") return <span className="bom-order-draft" title={status.draft_purchase_order_nos.join("、")}>计划中 {trimQuantity(status.draft_quantity)}</span>;
    if (status.state === "partial") return <span className="bom-order-partial" title={status.ordered_purchase_order_nos.join("、")}>部分下单 {trimQuantity(status.ordered_quantity)} / 需求 {trimQuantity(status.required_quantity)}</span>;
    return <span className="status-success" title={status.ordered_purchase_order_nos.join("、")}>已下单 {trimQuantity(status.ordered_quantity)}</span>;
  }
  const lockedHint = "这一行已经下过单，内容不能在计划里改；要改先「退回采购计划」";

  return (
    <>
      <Sheet open onOpenChange={(open) => { if (!open) onClose(); }}>
        <SheetContent className="material-issue-sheet purchase-plan-sheet">
          <SheetHeader>
            <SheetTitle>{plan ? `采购计划：${plan.planNo}` : "采购计划"}</SheetTitle>
            <SheetDescription>
              这张 BOM 的采购工作面：逐行填供应商、单价与预计到货，勾选后**按供应商收束下单**
              （一个供应商一张采购单，同一家**已有未到货的采购单就并进那张单**；币种在收束预览里每组各选）。
              下过的行留在计划里，看得见落到了哪张单。
            </SheetDescription>
          </SheetHeader>
          {loading ? <p className="panel-note">加载中…</p> : null}
          {error ? <p className="panel-note status-danger" data-testid="plan-error" role="alert">{error}</p> : null}
          {conflict ? (
            <div className="panel panel-body" data-testid="plan-conflict">
              <p className="panel-note status-danger">{conflict}</p>
              <p className="panel-note">你的本地改动还在（没有丢失）。重新加载会放弃本次修改。</p>
              <Button size="sm" variant="secondary" onClick={() => void load()}>重新加载最新版本（放弃本次修改）</Button>
            </div>
          ) : null}
          {plan ? (
            <div className="detail-list">
              <label>销售单<Input readOnly value={plan.orderNo} aria-label="销售单号" /></label>
              <label>货号<Input readOnly value={plan.itemNo ?? "-"} aria-label="货号" /></label>
              <label>客户<Input readOnly value={plan.customerName ?? "-"} aria-label="客户" /></label>
              <label>BOM 版本<Input readOnly value={String(plan.bomVersion ?? "-")} aria-label="BOM 版本" /></label>
              <label>状态<Input readOnly value={`${plan.statusLabel}（未下单 ${plan.unorderedCount} / 共 ${plan.lineCount}）`} aria-label="计划状态" /></label>
              {plan.bomDeleted ? <p className="panel-note status-warning">这张 BOM 已经被删除：计划仍按当时的需求保留，可以继续买或退回。</p> : null}
              {/* 孤立（2026-11-03）：销售单被删后采购计划不删，按计划继续下单/收货都还有效（与 BOM 被删是两件事）。 */}
              {plan.orphaned ? <p className="panel-note status-warning" data-testid="plan-orphan-hint">这张计划所属的销售单已被删除：计划原样保留为「孤立单据」，仍然可以继续下单与收货；如需把销售单接回来，请找管理员处理（删除是软删，数据没有丢）。</p> : null}
              {plan.bomExtraMaterialCount ? (
                // 口径 12：BOM 后来新增了物料**不自动插行**（计划可能已经部分下单），只提示。
                <p className="panel-note status-warning" data-testid="plan-bom-extra">
                  BOM 表比这份计划多 {plan.bomExtraMaterialCount} 个物料：计划是建立时的快照，不会自动跟着变。需要买就点「添加行」。
                </p>
              ) : null}
            </div>
          ) : null}

          <div className="page-actions">
            <Button size="sm" variant="secondary" data-testid="plan-add-row" onClick={addRow}>添加行</Button>
            <Button size="sm" variant="destructive" disabled={!selected.length} onClick={removeSelected}>{selected.length ? `移除选中 ${selected.length} 行` : "移除选中行"}</Button>
            <Button size="sm" data-testid="plan-save" disabled={busy === "save"} onClick={() => void save()}>保存计划</Button>
            <Button size="sm" variant="ghost" data-testid="plan-delete" disabled={busy === "delete"} onClick={() => setConfirmDelete(true)}>删除计划</Button>
          </div>

          {/* 填单价入口（2026-10-09）。用户原话：「我还是希望在采购计划中前端也能允许填写价格。
              也可以选择导入BOM的对应的物料的价格。」以及「我真没看到哪里可以手填单价的。可以重新设计这一块」——
              单价原来只是第 8 列里一个 6% 宽的输入框，14 列的表里确实看不出来。
              所以提一个状态条 + 一个专门逐行填的浮层（导入 BOM 参考单价也在浮层里）。 */}
          <div className="page-actions" data-testid="plan-price-bar">
            <Button size="sm" data-testid="plan-open-price-dialog" onClick={() => { setPriceImport(null); setPriceDialog(true); }}>
              {pendingPriceIndexesOfRows.length ? `填单价（还有 ${pendingPriceIndexesOfRows.length} 行没填）` : "填单价"}
            </Button>
            <span className="panel-note" data-testid="plan-price-bar-note">
              {pendingPriceIndexesOfRows.length
                ? `共 ${rows.length} 行，还有 ${pendingPriceIndexesOfRows.length} 行是 0 价：逐行手填，或从 BOM 参考单价导入（只补空格、不覆盖已填的价）。0 价的行**不会下单**（收束下单时留在计划里，补价后再下一波）。`
                : `共 ${rows.length} 行，单价都填好了；要改还是在这里改（点「保存计划」后生效）。`}
            </span>
          </div>

          {needsOutsideBomReason ? (
            <label className="purchase-edit-reason">BOM 外新增原因（{outsideBomRows.length} 行不在 BOM 表上，补料/替代料必填）
              <Input value={outsideBomReason} onChange={(event) => setOutsideBomReason(event.target.value)} aria-label="BOM 外新增原因" placeholder="例如：原 BOM 物料缺货，改用替代料" />
            </label>
          ) : null}

          {/* BOM 参考单价预填的说明（2026-10-08 第二轮）：单价本来都是 0，一打开却有了数，
              不说来源就会被当成"供应商报价"。 */}
          {fromBomRows.length > 0 ? (
            <p className="panel-note" data-testid="plan-price-from-bom">
              {fromBomRows.length} 行的单价是按 <strong>BOM 表上的「参考单价」</strong>预填的（那几格带浅黄底）：
              它是"这个部件通常多少钱"的参考、不是供应商报价；<strong>保存计划后才会写进计划</strong>，逐行都能改。
              还空着的行说明 BOM 上也没填参考价 —— 点上面的「填单价」逐行手填，
              或在那个浮层里点「导入 BOM 参考单价」重新导一次（只补空格、不覆盖已填的价）。
            </p>
          ) : null}

          {/* 14 列：列宽全部由 `.plan-col-*` 显式指定（和 = 100%，`table-layout: fixed`），
              所以**不会有横向滚动条**。只读文本列加 `plan-cell-ellipsis`，hover 用原生 title 看全文；
              编辑格不加（对输入框做省略没有意义）。 */}
          <div className="table-wrap">
            <table className="data-table plan-draft-table">
              <thead>
                <tr>
                  <th className="plan-col-select"><input type="checkbox" aria-label="全选计划行" checked={rows.some((row) => !row.ordered) && selected.length === rows.filter((row) => !row.ordered).length} onChange={(event) => toggleAll(event.target.checked)} /></th>
                  <th className="plan-col-material">名称</th>
                  <th className="plan-col-model">型号</th>
                  <th className="plan-col-order">下单状态</th>
                  <th className="plan-col-qty">本次采购量</th>
                  <th className="plan-col-stock">当前库存量</th>
                  <th className="plan-col-unit">单位</th>
                  <th className="plan-col-price">单价</th>
                  <th className="plan-col-amount">行总价</th>
                  <th className="plan-col-supplier">供应商</th>
                  <th className="plan-col-address">供应商地址</th>
                  <th className="plan-col-contact">联系人</th>
                  <th className="plan-col-expected">预计到货</th>
                  <th className="plan-col-action">操作</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => (
                  <tr key={row.id ?? `new-${index}`} data-testid={`plan-row-${index}`}>
                    <td className="plan-col-select"><input type="checkbox" aria-label={`选择第 ${index + 1} 行`} disabled={row.ordered} checked={selected.includes(index)} onChange={() => toggleRow(index)} /></td>
                    <td className="plan-col-material">
                      {/*
                        物料池会随物料清单一起长（用户 2026-11-13：「所有下拉列表……都要有搜索功能」），
                        所以换成带搜索的下拉。原来那条「这一行自己的物料已不在池里」的**逐项 disabled**
                        语义不能丢（见 `materialOptionsOf` 的注释）：改为把禁用值传给 `disabledValues` ——
                        名字照旧显示得出来，但选不中，避免把停用物料选到别的行上。
                        `title` 与 `disabled` 原样透传：已下单的行仍然锁住整格。
                      */}
                      <SearchableSelect
                        value={row.materialId}
                        options={materialOptionsOf(row)}
                        disabledValues={materialOptionsOf(row).filter((option) => option.disabled).map((option) => option.value)}
                        disabled={row.ordered}
                        title={row.ordered ? lockedHint : undefined}
                        placeholder="请选择物料"
                        label="物料"
                        searchPlaceholder="搜索物料编码、名称、规格或颜色"
                        noResultsText="没有匹配的物料（到【采购 → 物料清单】维护物料池）"
                        onChange={(value) => changeMaterial(index, value)}
                      />
                    </td>
                    <td className="plan-col-model"><Input value={row.model} disabled={row.ordered} title={row.ordered ? lockedHint : undefined} onChange={(event) => updateRow(index, { model: event.target.value })} /></td>
                    <td className="plan-col-order">
                      {orderStatusCell(row)}
                      {orderedCell(row) ? <div>{orderedCell(row)}</div> : null}
                      {/* 已下单但单价还是 0 —— 2026-10-11 起新单不会再出现这一档，但 10-09~10-11
                          之间按「价格待定」下过的单还在库里，它们的补价入口就在这里，所以标记留着。 */}
                      {row.ordered && !(Number(row.unitPrice) > 0)
                        ? <div><span className="status-warning" data-testid={`plan-price-pending-${index}`} title="这张单是 2026-10-11 之前按「价格待定」下的：到货登记前必须先补单价">价格待定（需补价）</span></div>
                        : null}
                    </td>
                    <td className="plan-col-qty"><Input type="number" min="0" step="0.0001" value={row.quantity} disabled={row.ordered} title={row.ordered ? lockedHint : undefined} onChange={(event) => updateRow(index, { quantity: event.target.value })} /></td>
                    <td className="plan-col-stock plan-cell-ellipsis" title={otherUnitStock(row.materialId, row.unitId) ? `本行单位库存 ${stockFor(row.materialId, row.unitId)}；另有 ${otherUnitStock(row.materialId, row.unitId)}（单位不同，未相加）` : undefined}>
                      {stockFor(row.materialId, row.unitId)}{otherUnitStock(row.materialId, row.unitId) ? <span className="panel-note">（另有 {otherUnitStock(row.materialId, row.unitId)}）</span> : null}
                    </td>
                    <td className="plan-col-unit">
                      <Select value={row.unitId || undefined} onValueChange={(value) => updateRow(index, { unitId: value, unitName: units.find((item) => item.id === value)?.name ?? "" })} disabled={row.ordered}>
                        <SelectTrigger title={row.ordered ? lockedHint : undefined}><SelectValue placeholder="单位" /></SelectTrigger>
                        <SelectContent>{unitOptionsOf(row).map((option) => <SelectItem key={option.value} value={option.value} disabled={option.disabled}>{option.label}</SelectItem>)}</SelectContent>
                      </Select>
                    </td>
                    {/* 单价格：`priceFromBom` 的行是"从 BOM 参考单价预填来的"——
                        用浅黄底 + title 标出来源（这一格只有 6% 宽，塞不下文字标签，见 globals.css）。
                        用户一改这一格就清掉标记：那一格从此是他填的。
                        2026-10-09：**已下单但单价是 0** 的行这一格仍然可填 —— 那是补价的唯一入口；
                        一旦补过价（> 0）就锁死，与其它已下单行一样（要改先「退回采购计划」）。 */}
                    <td className={`plan-col-price${row.priceFromBom ? " plan-price-from-bom" : ""}`}>
                      <Input
                        type="number" min="0" step="0.0001" value={row.unitPrice} disabled={row.ordered && Number(row.unitPrice) > 0}
                        placeholder="手填单价"
                        title={row.ordered
                          ? (Number(row.unitPrice) > 0 ? lockedHint : "已下单 · 单价还是 0：可以补填单价（保存计划后同步到那张采购单）；补上之后这一行就锁住了")
                          : row.priceFromBom ? `按 BOM 表的「参考单价」预填：${row.bomReferenceUnitPrice ?? ""} ${row.bomReferenceCurrency ?? DEFAULT_PLAN_CURRENCY}（还没保存；保存计划后生效，可改）` : undefined}
                        data-testid={`plan-price-${index}`}
                        aria-label={`第 ${index + 1} 行单价`}
                        onChange={(event) => updateRow(index, { unitPrice: event.target.value, priceFromBom: false })}
                      />
                    </td>
                    {/* 行总价：**只读派生**（数量 × 单价），本地即时算 —— 改一次数量或单价就能看见钱变了。
                        单价为 0 的行标红（**含已下单但价格待定的行**：那些行的钱还没定下来，
                        到货前必须先补价，所以同样要看得见）。 */}
                    <td className={`plan-col-amount plan-cell-ellipsis${!(Number(row.unitPrice) > 0) ? " status-danger" : ""}`} data-testid={`plan-amount-${index}`} title={`${row.currency ?? DEFAULT_PLAN_CURRENCY} ${lineAmountText(row.quantity, row.unitPrice)}`}>
                      {lineAmountText(row.quantity, row.unitPrice)}
                    </td>
                    <td className="plan-col-supplier">
                      {/* 下拉里可「＋ 新建供应商」（复用 BOM 那一份组件，不复制第二份）。 */}
                      <SupplierSelect
                        value={row.supplierId}
                        suppliers={suppliers}
                        disabled={row.ordered}
                        testId={`plan-supplier-select-${index}`}
                        onCreated={(supplier) => setSuppliers((current) => (current.some((item) => item.id === supplier.id) ? current : [...current, supplier]))}
                        onChange={(supplierId) => updateRow(index, { supplierId })}
                      />
                    </td>
                    {/* 地址/联系人：选中那家供应商的**实时主数据**，只读（口径 4）。
                        不会写进行状态，也不会因为改了这一格而多出第二个真源。 */}
                    <td className="plan-col-address plan-cell-ellipsis" title={row.supplierAddress ?? undefined}>{row.supplierAddress ?? "-"}</td>
                    <td className="plan-col-contact plan-cell-ellipsis" title={row.supplierContact ?? undefined}>{row.supplierContact ?? "-"}</td>
                    {/* 预计到货是**已下单行唯一还能改的内容列**（服务端会同步进那张采购明细）。 */}
                    <td className="plan-col-expected"><Input type="date" value={row.expectedDate} aria-label="预计到货日期" onChange={(event) => updateRow(index, { expectedDate: event.target.value })} /></td>
                    <td className="plan-col-action">
                      <Button size="icon" variant="ghost" title={row.ordered ? "已下单的行不能删除；要改先「退回采购计划」" : "删除行"} aria-label="删除行" disabled={row.ordered} onClick={() => { setRows((current) => current.filter((_, i) => i !== index)); setSelected([]); }}><Trash2 size={16} /></Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* 计划合计：**按币种分列**（金额不跨币种合计）。放在表下而不是做成第 15 列 ——
              它是"这一张计划一共要花多少"，不是某一行的事；而且多一列会把 1366px 上的表格挤横。
              「其中未下单」是采购员与财务真正问的那个问题：**还要花多少钱**。 */}
          <div className="plan-total" data-testid="plan-total">
            <span>计划合计 <strong>{amountSummaryText(planAmounts) || "CNY 0.00"}</strong>（{rows.length} 行）</span>
            <span className="panel-note">其中未下单 <strong data-testid="plan-total-unordered">{amountSummaryText(unorderedAmounts) || "CNY 0.00"}</strong>（{rows.filter((row) => !row.ordered).length} 行）</span>
          </div>

          <PlanOrderPreview
            groups={placedGroups}
            currencies={currencies}
            currencyOf={currencyOf}
            onCurrencyChange={(supplierId, currency) => setGroupCurrency((current) => ({ ...current, [supplierId]: currency }))}
            onOrder={() => void order()}
            busy={busy === "order"}
            heldBackRowNos={heldBackRowNos}
            selectedRowCount={selectedRows.length}
            openOrders={plan?.openPurchaseOrders ?? []}
          />
        </SheetContent>
      </Sheet>
      {priceDialog ? (
        <PlanPriceDialog
          planNo={plan?.planNo}
          rows={rows}
          importOutcome={priceImport}
          importing={busy === "import-price"}
          onImportBom={() => void importBomPricesIntoRows()}
          onChange={(index, patch) => updateRow(index, patch)}
          onClose={() => setPriceDialog(false)}
        />
      ) : null}
      {holdBackConfirm ? (
        // 「有行会被留下」的复核：0 价的行**不下单**（2026-10-11 用户口径），留在计划里等补价。
        // 说清哪几行、并且明确"确定之后只下有单价的那几行"，避免采购以为它们也发出去了。
        <ActionDialog
          open
          title="这几行还没填单价，本次不会下单"
          fields={[{ name: "note", type: "info", label: `第 ${holdBackConfirm.join("、")} 行还没填单价：本次下单**只下已填单价的行**，这 ${holdBackConfirm.length} 行会**留在计划里**，补上单价后再下一波。要一起下单就先关掉这个框，点上方「填单价」逐行手填（或在该浮层里「导入 BOM 参考单价」）再回来。` }]}
          submitLabel={`确定下单（只下有单价的 ${placedRows.length} 行）`}
          onOpenChange={(open) => { if (!open) setHoldBackConfirm(null); }}
          onSubmit={() => placeOrder()}
        />
      ) : null}
      {confirmDelete ? (
        <ActionDialog
          open
          title={`删除采购计划：${plan?.planNo ?? ""}`}
          submitLabel="确认删除"
          fields={[{ name: "note", label: "删除的是这份计划本身（BOM 表、采购单都不受影响）。已经下过单的行还在，所以有已下单行时会被拒绝。", type: "info" }]}
          onOpenChange={(open) => { if (!open) setConfirmDelete(false); }}
          onSubmit={() => removePlan()}
        />
      ) : null}
    </>
  );
}
