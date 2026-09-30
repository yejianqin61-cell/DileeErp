"use client";

// 销售单整页编辑器（2026-09-16 下单口径细化）。
//
// 为什么把「新建销售单」从弹窗改成整页：细化后光固化字段就有 37 个（材料 18 + 工艺 9 + 布量 5 +
// 表头 5）外加一张可增删的明细表，弹窗（ActionDialog）放不下——这是用户拍板的选择。
//
// 字段清单与载荷规则全部来自 `lib/sales-order-spec.ts`（纯函数，有 node:test 覆盖），
// 这个组件只负责渲染与取数，不再自己拼字段名——否则清单会分叉成「界面有、库里没有」。
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { PageHeader } from "../layout/app-shell";
import { ActionDialog, type ActionField } from "../ui/action-dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { SearchableSelect } from "../ui/searchable-select";
import { ErrorState, LoadingState } from "../feedback/states";
import { notifyError, notifySuccess } from "../ui/toaster";
import { apiGet, apiPatch, apiPost } from "../../lib/api-client";
import { apiErrorText } from "../../lib/api-error-text";
import { fetchCurrencyOptions, currencyOptionsWithCurrent, type CurrencyOption } from "../../lib/currency-catalogue";
import { itemNoKey } from "../../lib/item-no";
import { auditDetailFields, type AuditRow } from "../data/audit-columns";
import {
  SPEC_DETAIL_COLUMNS, SPEC_FABRIC_FIELDS, SPEC_HEADER_FIELDS, SPEC_MATERIAL_FIELDS, SPEC_MATERIAL_KEYS, SPEC_PROCESS_FIELDS,
  SPEC_SCALAR_KEYS, DEFAULT_SPEC_DETAIL_LABELS, SPEC_DETAIL_LABEL_MAX_LENGTH, detailLabelsWithDefaults, emptySpecDetailRow, isBlankSpecDetail,
  materialOptionLabel, materialRefsFromOrder, materialSpecText, specDetailLabelsFromOrder, validateSpecDetailLabels,
  specFromOrder, specPayload, specQuantityNotice, validateSpecDetails, type MaterialOption, type MaterialRefState, type SpecDetailRow,
} from "../../lib/sales-order-spec";
import { MaterialThumb } from "../procurement/material-image";
import { ItemNoInput, type ItemNoSuggestion } from "./item-no-input";

type Customer = { id: string; customerCode?: string; name: string; isActive?: boolean; currency?: string | null; contacts?: Array<{ id: string; name: string; phone?: string | null; isDefault?: boolean }> };
type Unit = { id: string; name: string };
type DetailResponse = AuditRow & Record<string, unknown> & { id: string; orderNo: string; status: string; customer?: { id: string }; contact?: { id: string } | null; specDetails?: Array<Record<string, unknown>>; materialRefs?: Array<Record<string, unknown>> };

/**
 * 改号影响面（`GET /sales-orders/:id/order-no-impact?order_no=新号`）。
 *
 * 为什么要先拉这个：改号会在**一个事务里**改掉全库 38 张表里属于这张单的行。用户看不见这个后果，
 * 所以保存前必须把「会同步改哪几类单据、各多少条」摆出来 —— 与后端执行用的是同一份登记表，
 * 说会改的表就是真会改的表。
 */
type OrderNoImpactTarget = { key: string; label: string; count: number };
type OrderNoImpact = {
  sales_order_id: string; current_order_no: string; next_order_no: string; changed: boolean;
  conflict: { order_no: string; order_id: string; status: string; deleted: boolean; message: string } | null;
  reason_required: boolean; targets: OrderNoImpactTarget[]; total: number;
  version_snapshots: number; reorder_references: number;
};

/** 保存响应：`order_no_changed` 只有改号那一次才会有（后端 update 的返回）。 */
type SavedOrder = { id: string; orderNo: string; order_no_changed?: boolean; previous_order_no?: string | null };

/** 影响面那句人话。抽成纯函数：测试可以直接钉住文案（不用去 render 一张对话框再读文字）。 */
export function orderNoImpactText(impact: OrderNoImpact): string {
  const head = impact.changed ? `订单号 ${impact.current_order_no} → ${impact.next_order_no}` : `订单号未变（${impact.current_order_no}）`;
  if (impact.conflict) return `${head}。${impact.conflict.message}`;
  const extra = [
    impact.version_snapshots ? `历史版本快照 ${impact.version_snapshots} 条` : "",
    impact.reorder_references ? `别的销售单上的返单来源 ${impact.reorder_references} 条` : "",
  ].filter(Boolean);
  if (!impact.total && !extra.length) return `${head}。这一单还没有下游单据，改号只改销售单本身。`;
  const detail = impact.targets.map((row) => `${row.label} ${row.count}`).join("、");
  const downstream = impact.total ? `将同步更新 ${impact.targets.length} 类下游单据共 ${impact.total} 条（${detail}）` : "没有下游单据";
  return `${head}。${downstream}${extra.length ? `，另有${extra.join("、")}` : ""}。改完旧单号只留在审计里。`;
}

/**
 * 基础字段：与弹窗时代同一批（口径没变，只是换了个更能装的形式）。
 *
 * `hint` 只用在「这一格改动的后果不在本页」的字段上（目前只有订单号）：提示必须贴在输入框旁边，
 * 而不是等用户点了保存才从弹窗里第一次看到。
 */
const BASE_FIELDS: ReadonlyArray<{ key: string; label: string; type?: "textarea" | "date" | "number"; required?: boolean; hint?: string }> = [
  { key: "order_no", label: "订单号", required: true, hint: "改这里会同步改下游全部单据（采购/生产/入库/应收应付…），保存前会先给你看影响面" },
  { key: "external_contract_no", label: "外部合同号" },
  { key: "customer_po_no", label: "客户 PO 号" },
  { key: "product_name", label: "产品名称", required: true },
  { key: "product_spec", label: "产品规格", type: "textarea" },
  { key: "quantity", label: "数量", type: "number", required: true },
  { key: "order_date", label: "下单日期", type: "date", required: true },
  { key: "delivery_date", label: "交货日期", type: "date" },
  { key: "unit_price", label: "单价", type: "number" },
  { key: "total_amount", label: "总金额", type: "number" },
  { key: "tax_rate", label: "税率", type: "number" },
  { key: "settlement_unit_price", label: "结算币价", type: "number" },
  { key: "receivable_amount", label: "应收金额", type: "number" },
  { key: "local_currency_amount", label: "本币金额", type: "number" },
];

const SETTLEMENT_METHODS: ReadonlyArray<readonly [string, string]> = [["", "（不填）"], ["tt", "T/T 电汇"], ["letter_of_credit", "信用证"], ["cash", "现金"], ["monthly", "月结"], ["other", "其他"]];

/**
 * 返单时必须重填的四格（与服务端 `reorderPreview().must_fill` 同一份清单）。
 *
 * 为什么前端还要存一份：服务端给的是**数据**（预览响应里的数组），而这里要在渲染时就知道
 * 「这一格要不要打标记」。两份都对不上时以服务端为准（它才决定建单能不能过），
 * 所以这条只是**提示**，不是校验 —— 真正的必填校验仍在保存前那几条 + 后端 DTO 上。
 */
const REORDER_MUST_FILL: ReadonlySet<string> = new Set(["order_no", "order_date", "quantity", "delivery_date"]);

/** 返单预览响应（`GET /sales-orders/reorder-preview`）里本组件用到的部分。 */
type ReorderPreview = {
  source_order_no: string;
  source_order_id: string;
  item_no: string;
  customer_id?: string | null;
  contact_id?: string | null;
  copy: Record<string, unknown>;
  must_fill: string[];
  warnings: string[];
};

/**
 * 返单来源横幅：回答「这张单是从哪来的」。
 *
 * · 新建态（返单）：来自 URL 的来源单，带「查看来源单」；
 * · 编辑态：单子上本来就记着来源，只读展示 —— 后端在更新接口上不接受改写 `reorder_from_order_no`，
 *   所以这里**不给**「换来源」的入口（给了就是一个点了必然 400 的按钮）。
 */
function ReorderBanner({ sourceOrderNo, sourceOrderId, itemNo, itemNoChanged }: { sourceOrderNo: string; sourceOrderId?: string; itemNo?: string | null; itemNoChanged?: boolean }) {
  if (!sourceOrderNo) return null;
  return (
    <section className="panel panel-body reorder-banner" data-testid="reorder-source-banner">
      <div className="reorder-banner-head">
        <span>由 <strong>{sourceOrderNo}</strong> 返单{itemNo ? <>（同货号 <strong>{itemNo}</strong>）</> : null}</span>
        {sourceOrderId ? <Link href={`/sales/orders/${sourceOrderId}/edit`} data-testid="reorder-source-link">查看来源单</Link> : null}
      </div>
      <p className="panel-note">数量、下单日期与交货日期必须按这一批重新填写；单价沿用上次，请复核。</p>
      {itemNoChanged ? (
        <p className="status-warning" data-testid="reorder-item-no-changed">
          货号已改动：这张单在【返单与总结】里会归到新的货号下，不再与 {sourceOrderNo} 同组。
        </p>
      ) : null}
    </section>
  );
}

/**
 * 后端字段名 → 界面中文名，用于把 400 的原因说到具体一格（`lib/api-error-text`）。
 *
 * 直接从上面这几张**已经在用的**清单拼出来，不另抄一份：抄一份的下场是「界面改了名字、
 * 报错还叫着旧名字」，而这种漂移没人会去看。整块数组的键（`spec_details`）也登记，
 * 这样「整行不合法」也能说成「细分明细：…」。
 */
const FIELD_LABELS: Record<string, string> = {
  ...Object.fromEntries(BASE_FIELDS.map((field) => [field.key, field.label])),
  ...Object.fromEntries(SPEC_HEADER_FIELDS),
  ...Object.fromEntries(SPEC_FABRIC_FIELDS),
  ...Object.fromEntries(SPEC_MATERIAL_FIELDS),
  ...Object.fromEntries(SPEC_PROCESS_FIELDS),
  ...Object.fromEntries(SPEC_DETAIL_COLUMNS),
  spec_details: "细分明细",
  customer_id: "客户",
  contact_id: "联系人",
  settlement_method: "结算方式",
  order_date: "下单日期",
  delivery_date: "交货日期",
  unit: "单位",
  currency: "币种",
  // 货号在基本信息里由专用输入框渲染（`ItemNoInput`），不在这条 BASE_FIELDS 循环里 ——
  // 但错误文案要用到它的中文名，所以单独登记一条。
  item_no: "货号",
};

/**
 * 失败原因：`apiErrorText` 会把后端的字段级 details 接在消息后面。
 *
 * 为什么不能只显示 `cause.message`（2026-09-20 现场问题）：DTO 校验失败时后端回的一直是
 * 「请求参数校验失败」+ `details: [{ field, rule, message }]`，而这里原来只取了 message，
 * 于是「明细第 2 行数量不是数字」和「布量填了字母」在界面上长得一模一样，用户只能盲试。
 */
const errorOf = (cause: unknown, fallback: string) => apiErrorText(cause, fallback, FIELD_LABELS);

export function SalesOrderEditor({ orderId }: { orderId?: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const editing = Boolean(orderId);
  /**
   * 返单（2026-09-26）：`/sales/orders/new?reorder_from_order_no=DL260001-1`。
   *
   * 用 URL 参数而不是内部状态：业务要能把「以这一单返单」的链接直接发给同事，
   * 也要能从【返单与总结】跳进来（那个页面的每一批都带这个链接）。
   */
  const reorderFromOrderNo = (searchParams.get("reorder_from_order_no") ?? "").trim();
  const reorderMode = !editing && reorderFromOrderNo !== "";
  const [base, setBase] = useState<Record<string, string>>({ order_date: new Date().toISOString().slice(0, 10), quantity: "1" });
  const [spec, setSpec] = useState<Record<string, string>>({});
  const [details, setDetails] = useState<SpecDetailRow[]>([emptySpecDetailRow()]);
  /**
   * 细分明细的自定义列名（用户 2026-09-30：「细分明细那边，可以改成自定义字段名称」）。
   * 只存**用户改过的**（空 = 用默认名），渲染与提交都过 `detailLabelsWithDefaults` /
   * `specDetailLabelsPayload`，不在渲染里各写一遍回退。
   */
  const [detailLabelOverrides, setDetailLabelOverrides] = useState<Record<string, string>>({});
  /** 改列名的弹窗（ActionDialog 的字段清单在这里现拼，见下面「修改列名」按钮）。 */
  const [labelDialog, setLabelDialog] = useState<{ title: string; fields: ActionField[]; submit: (values: Record<string, string>) => void | Promise<void> } | null>(null);
  // 材料明细的物料引用（用户 2026-09-24）：键 = 栏位请求键，值 = 引用的物料（null = 只填文字）。
  const [refs, setRefs] = useState<MaterialRefState>(() => Object.fromEntries(SPEC_MATERIAL_KEYS.map((key) => [key, null])));
  const [materials, setMaterials] = useState<MaterialOption[]>([]);
  // 货号候选（老板 2026-09-26 的「货号」字段）：来自 GET /sales-orders/item-nos。
  // 拉不到就降级成空列表 —— 输入框仍然能输新货号，**不能**因为建议列表失败把整单卡住。
  const [itemNoSuggestions, setItemNoSuggestions] = useState<ItemNoSuggestion[]>([]);
  /** 返单来源（预览成功后才有）：来源单号 + id（跳来源单用）+ 货号（横幅上显示「同货号」）。 */
  const [reorderSource, setReorderSource] = useState<{ order_no: string; order_id: string; item_no: string } | null>(null);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [units, setUnits] = useState<Unit[]>([]);
  const [currencies, setCurrencies] = useState<CurrencyOption[]>([]);
  const [audit, setAudit] = useState<AuditRow | null>(null);
  const [status, setStatus] = useState("draft");
  const [reason, setReason] = useState("");
  /**
   * 库里那个订单号（编辑态由 `load()` 记下来）。
   *
   * 为什么要单独存一份：判断"用户到底改没改号"必须和**库里现在的值**比，不能和渲染中的 `base` 比 ——
   * 后者会因为一次输入被重渲染。
   */
  const [savedOrderNo, setSavedOrderNo] = useState("");
  /** 改号确认弹窗（`null` = 没打开）：影响面 + 用户要填的原因。 */
  const [renameDialog, setRenameDialog] = useState<{ impact: OrderNoImpact; nextOrderNo: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [customerList, unitList, currencyList, materialList] = await Promise.all([
        apiGet<Customer[]>("/customers?page_size=200"),
        apiGet<Unit[]>("/units"),
        fetchCurrencyOptions().catch(() => [] as CurrencyOption[]),
        // 物料清单：引用选择器与缩略图都要用。失败时降级成空清单（那一格仍然能填空，
        // 不能因为物料池拉不到就把整张销售单卡住）。
        apiGet<MaterialOption[]>("/materials").catch(() => ({ data: [] as MaterialOption[], meta: {} })),
      ]);
      // 货号候选：独立取、独立降级（与物料清单同一条理由：建议是锦上添花，填字才是主干）。
      void apiGet<ItemNoSuggestion[]>("/sales-orders/item-nos").then((result) => setItemNoSuggestions(Array.isArray(result.data) ? result.data : [])).catch(() => setItemNoSuggestions([]));
      setCustomers(customerList.data.filter((item) => item.isActive !== false));
      setUnits(unitList.data);
      setCurrencies(currencyList);
      // 物料池拉不到时降级成空清单（那一格仍然能填空）——**不能**因为物料清单失败就把整张
      // 销售单卡住：引用是「锦上添花」，填字才是主干。`Array.isArray` 是给「接口回了非数组」兜底。
      setMaterials((Array.isArray(materialList.data) ? materialList.data : []).filter((item) => (item as { isActive?: boolean }).isActive !== false));
      if (orderId) {
        const order = (await apiGet<DetailResponse>(`/sales-orders/${orderId}`)).data;
        setBase({
          order_no: String(order.orderNo ?? ""),
          customer_id: String(order.customer?.id ?? ""),
          contact_id: String(order.contact?.id ?? ""),
          external_contract_no: String(order.externalContractNo ?? ""),
          customer_po_no: String(order.customerPoNo ?? ""),
          product_name: String(order.productName ?? ""),
          product_spec: String(order.productSpec ?? ""),
          quantity: String(order.quantity ?? ""),
          unit: String(order.unit ?? ""),
          order_date: String(order.orderDate ?? "").slice(0, 10),
          delivery_date: String(order.deliveryDate ?? "").slice(0, 10),
          currency: String(order.currency ?? ""),
          unit_price: asText(order.unitPrice),
          total_amount: asText(order.totalAmount),
          tax_rate: asText(order.taxRate),
          settlement_unit_price: asText(order.settlementUnitPrice),
          receivable_amount: asText(order.receivableAmount),
          settlement_method: String(order.settlementMethod ?? ""),
          local_currency_amount: asText(order.localCurrencyAmount),
          // 货号是**列名**（`itemNo`），不在 37 个细化标量里 —— 直接读列名，不走 specFromOrder。
          item_no: String(order.itemNo ?? ""),
        });
        // ⚠️ 必须过 `specFromOrder`：接口给的是 Prisma **列名**（`ribSpec` / `fabricUsageCanopy`），
        // 而表单按**请求键**（`rib_spec`）取值。直接 `order[key]` 会全部读成空 —— 见该函数的注释。
        setSpec(specFromOrder(order));
        setRefs(materialRefsFromOrder(order));
        // 明细列名的自定义覆盖（接口给的是**列名**形状 `specDetailLabels`，函数里两种都认）。
        setDetailLabelOverrides(specDetailLabelsFromOrder(order));
        const rows = (order.specDetails ?? []).map((row) => ({
          group_name: String(row.groupName ?? ""), name: String(row.name ?? ""), color: String(row.color ?? ""),
          barcode: String(row.barcode ?? ""), quantity: asText(row.quantity), unit: String(row.unit ?? ""),
        }));
        setDetails(rows.length ? rows : [emptySpecDetailRow()]);
        setAudit(order);
        setStatus(String(order.status ?? "draft"));
        setSavedOrderNo(String(order.orderNo ?? ""));
      } else if (reorderFromOrderNo) {
        // 返单：先拉预览，再把结果**一次性**灌进四块 state。
        // 逐键 set 会与 `setBaseField` 的浅合并产生竞态，出现「填了一半」的表单 ——
        // 而填了一半的表单最危险：销售以为工艺已经带过来了，直接存下去就是一张缺工艺的单。
        const preview = (await apiGet<ReorderPreview>(`/sales-orders/reorder-preview?order_no=${encodeURIComponent(reorderFromOrderNo)}`)).data;
        const copy = (preview.copy ?? {}) as Record<string, unknown>;
        const text = (value: unknown) => (value === null || value === undefined ? "" : String(value));
        setBase({
          // 必须重填的四格**留空**：来源单的数量/下单日/交期是上一批的口径，抄过来就是错的下单数据。
          // 页面上它们带「返单必填」提示（见 REORDER_MUST_FILL）。
          order_no: "", order_date: "", quantity: "", delivery_date: "",
          customer_id: text(preview.customer_id),
          contact_id: text(preview.contact_id),
          product_name: text(copy.product_name),
          product_spec: text(copy.product_spec),
          unit: text(copy.unit),
          currency: text(copy.currency),
          customer_po_no: text(copy.customer_po_no),
          external_contract_no: text(copy.external_contract_no),
          unit_price: text(copy.unit_price),
          settlement_unit_price: text(copy.settlement_unit_price),
          tax_rate: text(copy.tax_rate),
          settlement_method: text(copy.settlement_method),
          item_no: text(preview.item_no),
          // 总金额/应收/本币金额**故意不预填**：它们由数量派生，抄过来必然与新数量矛盾。
        });
        // 预览的 `copy` 用的是**请求键**（与快照同形状），正好是 `specFromOrder` 认的第一种形状。
        setSpec(specFromOrder(copy));
        const detailRows = Array.isArray(copy.spec_details) ? (copy.spec_details as Array<Record<string, unknown>>).map((row) => ({ group_name: text(row.group_name), name: text(row.name), color: text(row.color), barcode: text(row.barcode), quantity: text(row.quantity), unit: text(row.unit) })) : [];
        setDetails(detailRows.length ? detailRows : [emptySpecDetailRow()]);
        // 引用照抄：预览里带了物料摘要（`material_refs[].material`），所以能直接把芯片显示出来，
        // 不依赖物料池那一次请求成不成功。
        setRefs(materialRefsFromOrder({ material_refs: copy.material_refs }));
        // 明细列名跟着来源单（返单就是把上一批的工艺口径带过来，列名属于这个口径的一部分）。
        setDetailLabelOverrides(specDetailLabelsFromOrder(copy));
        setReorderSource({ order_no: preview.source_order_no, order_id: preview.source_order_id, item_no: text(preview.item_no) });
      }
    } catch (cause) {
      // 返单预览失败**必须出错误态**，不能退化成空表单：空表单会让销售以为「这单本来就没工艺要求」，
      // 直接存下去就是一张缺工艺的下单。
      setError(errorOf(cause, reorderMode ? "返单来源加载失败：请回到【返单与总结】重试，或新建普通销售单" : "销售单数据加载失败"));
    } finally {
      setLoading(false);
    }
  }, [orderId, reorderFromOrderNo, reorderMode]);

  useEffect(() => { void load(); }, [load]);

  const quantityNotice = useMemo(() => specQuantityNotice(base.quantity ?? "", base.unit ?? "", details), [base.quantity, base.unit, details]);
  const detailErrors = useMemo(() => validateSpecDetails(details), [details]);
  /** 当前生效的列名（默认名 + 这一单的覆盖）：表头、行内 aria-label、改列名弹窗都用它。 */
  const detailLabels = useMemo(() => detailLabelsWithDefaults(detailLabelOverrides), [detailLabelOverrides]);
  // 引用下拉的选项（label = `编码 / 名称 规格 颜色`，与全站物料选择器同一份文字口径）。
  // 搜索由 `SearchableSelect` 内部按 label 子串过滤 —— 所以「按编码」「按名称」「按规格」「按颜色」都能搜到。
  const materialOptions = useMemo(() => materials.map((material) => ({ value: material.id, label: materialOptionLabel(material) })), [materials]);
  const selectedCustomer = customers.find((item) => item.id === base.customer_id);
  const contacts = selectedCustomer?.contacts ?? [];

  const setBaseField = (key: string, value: string) => setBase((current) => ({ ...current, [key]: value }));
  const setDetailField = (index: number, key: string, value: string) => setDetails((current) => current.map((row, at) => (at === index ? { ...row, [key]: value } : row)));

  /**
   * 「修改列名」（用户 2026-09-30：「细分明细那边，可以改成自定义字段名称」）。
   *
   * 6 个列名**一次改完**，不做成"点某个表头就地编辑"：这一组名字是一起看的
   * （「品番/品名」与「颜色/配色」是同一张表的列），逐列弹窗只会让人漏改两格，
   * 而漏改的表现是"导出里一半是新名字、一半是旧名字"。
   * **留空 = 用默认名**（清空一格就是恢复那一列的默认），这一句写在占位文案里。
   */
  function openDetailLabels() {
    setLabelDialog({
      title: "细分明细的列名",
      fields: SPEC_DETAIL_COLUMNS.map(([key, defaultLabel], index) => ({
        name: key,
        label: `第 ${index + 1} 列（默认「${defaultLabel}」）`,
        defaultValue: detailLabelOverrides[key] ?? "",
        placeholder: `留空则用默认名：${defaultLabel}（最多 ${SPEC_DETAIL_LABEL_MAX_LENGTH} 字）`,
      })),
      submit: (values) => {
        // 只留非空的（空 = 恢复默认），键取自同一份列清单，不另抄一份。
        const next: Record<string, string> = {};
        for (const [key] of SPEC_DETAIL_COLUMNS) {
          const text = (values[key] ?? "").trim();
          if (text) next[key] = text;
        }
        setDetailLabelOverrides(next);
        setLabelDialog(null);
        notifySuccess("明细列名已更新（保存后跟着这张单导出）");
      },
    });
  }

  /**
   * 从物料清单里引用一个物料（用户 2026-09-24：「每个部件，既支持填空，也支持从现有的物料清单中引用」）。
   *
   * 选中会把物料的「名称 规格型号 颜色」**写进那一格**：工艺单上印的是文字（工厂照字做伞），
   * 只记一个引用的话那一格在纸上是空的。写进去之后仍然可改 —— 引用只是省掉手打，不是锁死这一格
   * （用户明确要的是「既支持填空，也支持引用」）。
   */
  function pickMaterial(key: string, materialId: string) {
    const material = materials.find((item) => item.id === materialId) ?? null;
    setRefs((current) => ({ ...current, [key]: material }));
    if (material) setSpec((current) => ({ ...current, [key]: materialSpecText(material) }));
  }
  /** 取消引用：**不动已经写好的文字**（用户想留着那些字就留着，清除引用只是不再挂图片）。 */
  function clearMaterialRef(key: string) {
    setRefs((current) => ({ ...current, [key]: null }));
  }

  /**
   * 保存前的最后一道分流：**改了订单号就先弹影响面确认**，其余情况直接落库。
   *
   * 为什么改号要多一步：它会在一个事务里改掉全库 38 张表里属于这张单的行（另加返单来源引用与
   * 版本快照）。用户看不见这个后果，所以先给一张「会同步改哪几类单据、各多少条」的清单，
   * 并强制填原因 —— 原因会进审计，事后要能回答「这张单什么时候从哪个号改成哪个号」。
   */
  async function save() {
    if (!base.order_no?.trim()) { setError("订单号必填"); return; }
    if (!base.customer_id) { setError("请选择客户"); return; }
    if (!base.product_name?.trim()) { setError("产品名称必填"); return; }
    if (!base.quantity?.trim()) { setError("数量必填"); return; }
    if (!base.unit?.trim()) { setError("请选择单位"); return; }
    if (!base.currency?.trim()) { setError("请选择币种"); return; }
    if (!base.order_date?.trim()) { setError("下单日期必填"); return; }
    if (detailErrors.length) { setError(`明细第 ${detailErrors[0].row} 行：${detailErrors[0].reason}`); return; }
    // 列名太长当场拦下：后端也会拒（SPEC_DETAIL_LABEL_TOO_LONG），但等一个来回才看到原因没必要。
    const labelProblem = validateSpecDetailLabels(detailLabelOverrides);
    if (labelProblem) { setError(labelProblem); return; }

    const nextOrderNo = (base.order_no ?? "").trim();
    if (editing && nextOrderNo !== savedOrderNo) { await openRenameDialog(nextOrderNo); return; }
    if (editing && status === "confirmed" && !reason.trim()) { setError("已确认销售单修改必须填写原因"); return; }

    await persist();
  }

  /** 拉影响面并打开确认弹窗（只读，不写任何东西）。 */
  async function openRenameDialog(nextOrderNo: string) {
    setError("");
    try {
      const impact = (await apiGet<OrderNoImpact>(`/sales-orders/${orderId}/order-no-impact?order_no=${encodeURIComponent(nextOrderNo)}`)).data;
      setRenameDialog({ impact, nextOrderNo });
    } catch (cause) {
      setError(errorOf(cause, "改号影响面加载失败"));
    }
  }

  /**
   * 真正落库。
   *
   * `orderNo` / `submitReason` 由改号弹窗直接传进来（**不能**靠 `setReason` 之后再读 state：
   * 那是下一次渲染的值，读到的还是空的）。`rethrow` 给弹窗用 —— 失败时把原因留在弹窗里显示，
   * 而不是关掉弹窗把用户填的一堆字段丢在页面上。
   */
  async function persist(orderNo?: string, submitReason?: string, options: { rethrow?: boolean } = {}) {
    setSaving(true);
    setError("");
    const payload: Record<string, unknown> = { ...base, ...specPayload(spec, details, refs, detailLabelOverrides) };
    // 基础字段的空串当「没填」删掉：可选字段的 @IsDecimal/@IsDateString 会因为空串报 400。
    // 细化字段相反——空串 = 清除这一格，必须原样发出去（`specPayload` 已经把 37 个键都带上了）。
    for (const key of Object.keys(base)) if (base[key] === "" && !SPEC_SCALAR_KEYS.includes(key)) delete payload[key];
    // 货号与细化标量同语义：**空串 = 清除这一格**（落 NULL），不是「不动」。上面那条循环会把空串删掉，
    // 所以这里显式补回来 —— 否则「把货号删空再保存」会变成「什么都没发生」。
    payload.item_no = (base.item_no ?? "").trim() || null;
    if (editing) {
      // 客户不可改（后端 update 也不接受这个键）。
      delete payload.customer_id;
      // 订单号**只在真改了的时候发**：没改就不发（老口径下"不发"是为了防误改，现在是为了不动全链）。
      const renaming = orderNo !== undefined && orderNo !== savedOrderNo;
      if (renaming) payload.order_no = orderNo;
      else delete payload.order_no;
      payload.reason = (submitReason ?? reason).trim() || undefined;
    } else if (reorderSource) {
      // 返单来源只在**新建**时带（后端在更新接口上不接受改写它）。
      payload.reorder_from_order_no = reorderSource.order_no;
    }
    try {
      const saved = editing
        ? (await apiPatch<SavedOrder>(`/sales-orders/${orderId}`, payload)).data
        : (await apiPost<SavedOrder>("/sales-orders", payload)).data;
      if (saved.order_no_changed) notifySuccess(`订单号已改为 ${saved.orderNo}（下游单据已同步）`);
      else notifySuccess(editing ? "销售单已保存" : `销售单已创建（${saved.orderNo}）`);
      router.push("/sales/orders");
    } catch (cause) {
      // 保存失败留在页面上：用户填的 37 格 + 明细不能因为一次网络抖动白填。
      const message = errorOf(cause, "保存失败");
      setError(message);
      notifyError(message);
      if (options.rethrow) throw new Error(message);
    } finally {
      setSaving(false);
    }
  }

  /**
   * 改号弹窗的字段清单必须**记住身份**（`useMemo`）。
   *
   * `ActionDialog` 的 `useEffect` 依赖 `fields`，每次依赖变化都会 `setValues(...)` 一次；
   * 如果这里每次渲染都现拼一个新数组，就会「setValues → 重渲染 → 新数组 → 再 setValues」无限循环
   * （React 会报 Maximum update depth exceeded）。`renameDialog` 是 state，身份稳定，
   * 所以把它当依赖就够。
   */
  const renameFields = useMemo<ActionField[]>(() => renameDialog ? [
    { name: "impact", label: orderNoImpactText(renameDialog.impact), type: "info" },
    { name: "reason", label: "改号原因", type: "textarea", required: true, placeholder: "为什么改（写进审计，事后按旧号也能查到这次改动）" },
  ] : [], [renameDialog]);

  if (loading) return <div className="page-root" data-testid="sales-order-editor"><PageHeader title={editing ? "编辑销售单" : "新建销售单"} breadcrumb={["客户与销售", "销售单"]} /><LoadingState /></div>;

  /**
   * 返单来源拉不到时**不渲染表单**。
   *
   * 只在错误横幅下面留一张空白表单是不够的：空白表单看起来就是「这一单本来就没有工艺要求」，
   * 销售填几个数直接存下去，得到的是一张缺工艺的下单 —— 而返单的全部意义就是沿用上一批的工艺。
   * 所以这里退成一张纯粹的失败页，只给重试与返回。
   */
  if (reorderMode && !reorderSource) {
    return (
      <div className="page-root" data-testid="sales-order-editor">
        <PageHeader title="新建销售单（返单）" breadcrumb={["客户与销售", "销售单"]} />
        <section className="panel"><ErrorState message={error || "返单来源加载失败"} onRetry={() => void load()} /></section>
        <section className="panel panel-body"><Button variant="secondary" onClick={() => router.push("/sales/orders")}>返回销售单列表</Button></section>
      </div>
    );
  }

  return (
    <div className="page-root" data-testid="sales-order-editor">
      <PageHeader title={editing ? `编辑销售单 ${base.order_no ?? ""}` : "新建销售单"} breadcrumb={["客户与销售", "销售单"]}>
        <Button variant="secondary" onClick={() => router.push("/sales/orders")} disabled={saving}>取消</Button>
        <Button onClick={() => void save()} disabled={saving} data-testid="sales-order-save">{saving ? "保存中…" : "保存"}</Button>
      </PageHeader>
      {error && <section className="panel"><ErrorState message={error} onRetry={() => void load()} /></section>}
      <ActionDialog open={Boolean(labelDialog)} onOpenChange={(open) => { if (!open) setLabelDialog(null); }} title={labelDialog?.title ?? "细分明细的列名"} fields={labelDialog?.fields ?? []} onSubmit={(values) => { void labelDialog?.submit(values); }} />
      {/*
        改号确认（2026-09-30）：影响面 + 原因，两者缺一不可。
        `info` 那个字段不是输入项，是 ActionDialog 支持的只读说明格 —— 影响面文案直接用它渲染，
        用户要签字的那一格只有「原因」。
      */}
      <ActionDialog
        open={Boolean(renameDialog)}
        onOpenChange={(open) => { if (!open) setRenameDialog(null); }}
        title="确认修改订单号"
        submitLabel="确认改号"
        fields={renameFields}
        onSubmit={async (values) => {
          const nextOrderNo = renameDialog?.nextOrderNo;
          if (!nextOrderNo) return;
          setReason(values.reason ?? "");
          await persist(nextOrderNo, values.reason, { rethrow: true });
        }}
      />

      {/*
        返单横幅（2026-09-26）：回答「这张单是从哪来的」。
        · 新建态：来自 URL 的来源单，带「查看来源单」；
        · 编辑态：单子上本来就记着来源（`reorderFromOrderNo`），只读展示 ——
          后端在更新接口上不接受改写它，所以这里不给「换来源」的入口。
      */}
      <ReorderBanner
        sourceOrderNo={reorderSource?.order_no ?? String((audit as Record<string, unknown> | null)?.reorderFromOrderNo ?? "")}
        sourceOrderId={reorderSource?.order_id}
        itemNo={reorderSource?.item_no ?? (audit as Record<string, unknown> | null)?.itemNo as string | undefined}
        itemNoChanged={reorderMode && reorderSource !== null && itemNoKey(base.item_no ?? "") !== itemNoKey(reorderSource.item_no)}
      />

      <section className="panel">
        <div className="panel-heading"><h2>基本信息</h2><span className="panel-note">这些是原销售单就有的字段，口径没变</span></div>
        <div className="panel-body form-grid">
          <label>客户
            <Select value={base.customer_id ?? ""} onValueChange={(value) => { setBaseField("customer_id", value); setBaseField("contact_id", ""); }}>
              <SelectTrigger data-testid="sales-base-customer_id"><SelectValue placeholder="请选择客户" /></SelectTrigger>
              <SelectContent>{customers.map((item) => <SelectItem key={item.id} value={item.id}>{item.customerCode ? `${item.customerCode} / ` : ""}{item.name}</SelectItem>)}</SelectContent>
            </Select>
          </label>
          <label>联系人
            <Select value={base.contact_id ?? ""} onValueChange={(value) => setBaseField("contact_id", value)} disabled={!contacts.length}>
              <SelectTrigger data-testid="sales-base-contact_id"><SelectValue placeholder={contacts.length ? "请选择联系人" : "该客户没有联系人"} /></SelectTrigger>
              <SelectContent>{contacts.map((item) => <SelectItem key={item.id} value={item.id}>{item.name}{item.phone ? ` / ${item.phone}` : ""}</SelectItem>)}</SelectContent>
            </Select>
          </label>
          <label>单位
            <Select value={base.unit ?? ""} onValueChange={(value) => setBaseField("unit", value)}>
              <SelectTrigger data-testid="sales-base-unit"><SelectValue placeholder="请选择单位" /></SelectTrigger>
              <SelectContent>{units.map((item) => <SelectItem key={item.id} value={item.name}>{item.name}</SelectItem>)}</SelectContent>
            </Select>
          </label>
          <label>币种
            <Select value={base.currency ?? ""} onValueChange={(value) => setBaseField("currency", value)}>
              <SelectTrigger data-testid="sales-base-currency"><SelectValue placeholder="请选择币种" /></SelectTrigger>
              <SelectContent>{currencyOptionsWithCurrent(currencies, base.currency).map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent>
            </Select>
          </label>
          <label>结算方式
            <Select value={base.settlement_method ?? ""} onValueChange={(value) => setBaseField("settlement_method", value)}>
              <SelectTrigger data-testid="sales-base-settlement_method"><SelectValue placeholder="（不填）" /></SelectTrigger>
              <SelectContent>{SETTLEMENT_METHODS.filter(([value]) => value !== "").map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent>
            </Select>
          </label>
          {/*
            货号（老板 2026-09-26：「每个销售单多一个字段，叫做货号」）：可挑既有、也可直接输新的。
            放在基本信息里而不是塞进 `BASE_FIELDS` —— 那条循环只渲染纯 Input，塞进去会让它长出一个
            特例分支；而货号的候选列表是**跨单**的（这个字段的语义就是跨单复用），与循环里那些
            「只属于这一张单」的字段不是一回事。
          */}
          <label>货号
            <ItemNoInput
              value={base.item_no ?? ""}
              onChange={(value) => setBaseField("item_no", value)}
              suggestions={itemNoSuggestions}
              disabled={saving}
              testId="sales-base-item_no"
            />
          </label>
          {BASE_FIELDS.map((field) => (
            <label key={field.key}>{field.label}
              {/* 返单时这四格必须重填：来源单的数量/日期是上一批的口径（后端 must_fill 同一份清单）。 */}
              {reorderMode && REORDER_MUST_FILL.has(field.key)
                ? <span className="reorder-must-fill" data-testid={`reorder-must-fill-${field.key}`}>（返单必填）</span>
                : field.required ? "（必填）" : ""}
              {/* 后果不在本页的字段（目前只有订单号）：提示贴在输入框旁边，不要等保存时才第一次看到。 */}
              {field.hint && <span className="panel-note" data-testid={`sales-base-${field.key}-hint`}>{field.hint}</span>}
              {field.type === "textarea"
                ? <textarea className="ui-input" rows={2} data-testid={`sales-base-${field.key}`} value={base[field.key] ?? ""} onChange={(event) => setBaseField(field.key, event.target.value)} />
                : <Input type={field.type === "number" ? "text" : field.type ?? "text"} inputMode={field.type === "number" ? "decimal" : undefined} data-testid={`sales-base-${field.key}`} value={base[field.key] ?? ""} onChange={(event) => setBaseField(field.key, event.target.value)} />}
            </label>
          ))}
        </div>
      </section>

      <section className="panel">
        <div className="panel-heading"><h2>工艺单表头</h2><span className="panel-note">按模板：工厂 / 完工日期备注 / 注意事项 / 正唛 / 侧唛</span></div>
        <div className="panel-body form-grid">
          {SPEC_HEADER_FIELDS.map(([key, label]) => (
            <label key={key}>{label}
              {key === "attention_note" || key === "shipping_mark_front" || key === "shipping_mark_side"
                ? <textarea className="ui-input" rows={2} data-testid={`sales-spec-${key}`} value={spec[key] ?? ""} onChange={(event) => setSpec((current) => ({ ...current, [key]: event.target.value }))} />
                : <Input data-testid={`sales-spec-${key}`} value={spec[key] ?? ""} onChange={(event) => setSpec((current) => ({ ...current, [key]: event.target.value }))} />}
            </label>
          ))}
        </div>
      </section>

      <section className="panel">
        <div className="panel-heading">
          <h2>材料明细</h2>
          <span className="panel-note">两张样本的并集共 18 项；留空的项导出时不印该行。每一格<strong>既可以手打文字，也可以从物料清单里引用一个物料</strong>（选中会把名称/规格/颜色填进格子，并带上它的图片）</span>
        </div>
        <div className="panel-body form-grid">
          {SPEC_MATERIAL_FIELDS.map(([key, label]) => {
            const ref = refs[key] ?? null;
            return (
              <div key={key} className="material-ref-field">
                <label>{label}
                  <textarea className="ui-input" rows={2} data-testid={`sales-spec-${key}`} value={spec[key] ?? ""} onChange={(event) => setSpec((current) => ({ ...current, [key]: event.target.value }))} />
                </label>
                <div className="action-row">
                  {/*
                    用**可搜索**的下拉（用户 2026-09-26：「材料明细，引用的下拉列表也支持搜索」）：
                    物料池动辄几百条，靠肉眼在一长串里找一个伞骨是不现实的。
                    `ui/searchable-select` 是全站既有的搜索下拉原语（应收账款科目、工资科目等在用），
                    这里不另造一个：过滤语义（label 与 value 都命中、忽略大小写）只该有一处实现。
                  */}
                  <SearchableSelect
                    testId={`sales-material-ref-${key}`}
                    value={ref?.id ?? ""}
                    options={materialOptions}
                    onChange={(value) => pickMaterial(key, value)}
                    placeholder="从物料清单引用…"
                    label={`${label}：从物料清单引用`}
                    searchPlaceholder="输入物料编码 / 名称 / 规格 / 颜色搜索"
                    noResultsText="没有匹配的物料（可到【采购 → 物料清单】新建）"
                  />
                  {ref && <MaterialThumb materialId={ref.id} version={ref.image?.sha256} alt={materialOptionLabel(ref)} size={36} />}
                  {ref && <Button size="sm" variant="ghost" data-testid={`sales-material-ref-clear-${key}`} onClick={() => clearMaterialRef(key)}>清除引用</Button>}
                </div>
                {/* 引用了但那个物料还没有图 —— 导出时这一格没有图可带。说出来，别让用户以为是导出坏了。 */}
                {ref && !ref.image && <span className="panel-note" data-testid={`sales-material-ref-no-image-${key}`}>该物料还没有图片（可到【采购 → 物料清单】上传）</span>}
              </div>
            );
          })}
        </div>
      </section>

      <section className="panel">
        <div className="panel-heading"><h2>工艺要求</h2><span className="panel-note">导出时按填了的条目重新编号，不会出现断号</span></div>
        <div className="panel-body form-grid">
          {SPEC_PROCESS_FIELDS.map(([key, label]) => (
            <label key={key}>{label}
              <textarea className="ui-input" rows={2} data-testid={`sales-spec-${key}`} value={spec[key] ?? ""} onChange={(event) => setSpec((current) => ({ ...current, [key]: event.target.value }))} />
            </label>
          ))}
        </div>
      </section>

      <section className="panel">
        <div className="panel-heading"><h2>布量（Y/DZ）</h2><span className="panel-note">模板里的五个数值格；样本2 没有这一区，留空即可</span></div>
        <div className="panel-body form-grid">
          {SPEC_FABRIC_FIELDS.map(([key, label]) => (
            <label key={key}>{label}
              <Input inputMode="decimal" data-testid={`sales-spec-${key}`} value={spec[key] ?? ""} onChange={(event) => setSpec((current) => ({ ...current, [key]: event.target.value }))} />
            </label>
          ))}
        </div>
      </section>

      <section className="panel">
        <div className="panel-heading">
          <h2>细分明细</h2>
          <span className="panel-note">一张通用表：用「分组名」区分（伞布明细 / 伞头配色 / 外层花色搭配…）；图片不录入、导出留空。列名可以改成你们的叫法，导出件跟着这张单印。</span>
          <Button size="sm" variant="secondary" data-testid="sales-detail-labels" onClick={openDetailLabels}>修改列名</Button>
          <Button size="sm" variant="secondary" data-testid="sales-detail-add" onClick={() => setDetails((current) => [...current, emptySpecDetailRow()])}>加一行</Button>
        </div>
        <div className="panel-body">
          {quantityNotice && <p className="status-warning" data-testid="sales-quantity-notice">{quantityNotice}</p>}
          {detailErrors.length > 0 && <div className="status-error" data-testid="sales-detail-errors">{detailErrors.map((item) => <p key={`${item.row}-${item.reason}`}>第 {item.row} 行：{item.reason}</p>)}</div>}
          <div className="table-wrap">
            <table className="ui-table">
              <thead><tr>{SPEC_DETAIL_COLUMNS.map(([key]) => <th key={key} data-testid={`sales-detail-head-${key}`}>{detailLabels[key]}</th>)}<th>操作</th></tr></thead>
              <tbody>
                {details.map((row, index) => (
                  <tr key={index} data-testid={`sales-detail-row-${index}`}>
                    {SPEC_DETAIL_COLUMNS.map(([key]) => (
                      <td key={key}>
                        <Input aria-label={detailLabels[key]} data-testid={`sales-detail-${index}-${key}`} value={row[key as keyof SpecDetailRow]} onChange={(event) => setDetailField(index, key, event.target.value)} />
                      </td>
                    ))}
                    <td>
                      <Button size="sm" variant="ghost" data-testid={`sales-detail-remove-${index}`} disabled={details.length === 1 && isBlankSpecDetail(row)} onClick={() => setDetails((current) => (current.length === 1 ? [emptySpecDetailRow()] : current.filter((_, at) => at !== index)))}>删除</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {editing && (
        <section className="panel">
          <div className="panel-heading"><h2>提交</h2><span className="panel-note">已确认的单子改核心字段要填原因（与全站口径一致）</span></div>
          <div className="panel-body">
            {audit && <p className="panel-note" data-testid="sales-order-audit">{auditDetailFields(audit).map((field) => `${field.label} ${field.value}`).join("；")}</p>}
            {status === "confirmed" && <label>修改原因（必填）
              <textarea className="ui-input" rows={2} data-testid="sales-change-reason" value={reason} onChange={(event) => setReason(event.target.value)} />
            </label>}
          </div>
        </section>
      )}
    </div>
  );
}

/** Prisma 的数字/日期字段回填成输入框文本（Decimal 会以字符串来，日期带时间要截断）。 */
function asText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value);
}
