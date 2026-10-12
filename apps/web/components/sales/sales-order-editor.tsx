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
  SPEC_SCALAR_KEYS, DEFAULT_SPEC_DETAIL_LABELS, MATERIAL_EXTRA_LIMIT, SPEC_DETAIL_LABEL_MAX_LENGTH, detailLabelsWithDefaults, emptyMaterialExtraRow, emptySpecDetailRow, isBlankSpecDetail,
  materialExtrasFromOrder, materialOptionLabel, materialRefsFromOrder, materialSpecText, specDetailLabelsFromOrder, validateMaterialExtras, validateSpecDetailLabels,
  specFromOrder, specPayload, specQuantityNotice, validateSpecDetails, type MaterialExtraRow, type MaterialOption, type MaterialRefState, type SpecDetailRow,
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
 * 复制 / 返单时必须重填的四格（与服务端 `must_fill` 同一份清单：`reorderPreview` 与 `copySnapshot`）。
 *
 * 为什么前端还要存一份：服务端给的是**数据**（响应里的数组），而这里要在渲染时就知道
 * 「这一格要不要打标记」。两份都对不上时以服务端为准（它才决定建单能不能过），
 * 所以这条只是**提示**，不是校验 —— 真正的必填校验仍在保存前那几条 + 后端 DTO 上。
 */
const MUST_FILL_FIELDS: ReadonlySet<string> = new Set(["order_no", "order_date", "quantity", "delivery_date"]);

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
 * 复制快照（`GET /sales-orders/:id/copy-snapshot`）里本组件用到的部分。
 *
 * 与 `ReorderPreview` 的形状**故意保持一致**（`customer_id` / `contact_id` / `copy` / `must_fill`），
 * 因为两条路共用同一个预填函数（见 `applyCopiedPayload`）；多一套形状就是多一处会漂移的地方。
 * `item_no` 在这里放在 `copy` 里（它是"这一单卖的是什么"的一部分），返单那边在顶层（横幅要显示），
 * 预填函数两种都认。
 */
type CopySnapshot = {
  source_order_no: string;
  source_order_id: string;
  source_status?: string;
  customer_id?: string | null;
  contact_id?: string | null;
  copy: Record<string, unknown>;
  must_fill: string[];
  dropped?: { material_refs?: string[]; material_extras?: string[] };
  warnings?: string[];
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
 * 「由 X 复制」横幅（2026-10-XX）。
 *
 * 为什么文案里要**明说新单不记来源**：这张单的工艺与材料跟来源单一模一样，看起来就该归进
 * 【返单与总结】的返单分组 —— 但它没有来源链，也不该有。不说清，销售会去返单分组里找这张单，
 * 找不到只会以为系统坏了；更糟的是有人"顺手"把来源补上，那张单从此被算成客户返单，
 * 返单统计里多一张假单（用户明确要求普通复制与返单分开）。
 */
function CopyBanner({ sourceOrderNo, sourceOrderId, dropped }: { sourceOrderNo: string; sourceOrderId?: string; dropped?: string[] }) {
  if (!sourceOrderNo) return null;
  return (
    <section className="panel panel-body copy-banner" data-testid="copy-source-banner">
      <div className="copy-banner-head">
        <span>由 <strong>{sourceOrderNo}</strong> 复制</span>
        {sourceOrderId ? <Link href={`/sales/orders/${sourceOrderId}/edit`} data-testid="copy-source-link">查看来源单</Link> : null}
      </div>
      <p className="panel-note">订单号、数量、下单日期与交货日期要按这一张单重填；单价沿用上次，请复核。新单不记来源，不会出现在【返单与总结】的返单分组里。</p>
      {/* 剔掉了引用就当面说：那一格的图片没了是**预期行为**，不是导出坏了。 */}
      {dropped?.length ? <p className="status-warning" data-testid="copy-dropped-materials">来源单引用的物料已不存在，复制时已剔掉：{dropped.join("、")}</p> : null}
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
  /**
   * 普通复制（2026-10-11）：`/sales/orders/new?copy_from_id=<销售单 id>`。
   *
   * 与返单同样是 URL 参数而不是内部状态：列表每行的「复制」就是一个链接，业务要能把它发给同事。
   * 用 **id** 而不是单号：列表行手上就是 id，而复制这条路口径上"不限状态、不要求货号"，
   * 没有任何一步需要先知道单号（返单用单号是因为返单分组与货号链是围绕单号转的）。
   */
  const copyFromId = (searchParams.get("copy_from_id") ?? "").trim();
  const copyMode = !editing && copyFromId !== "";
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
  /**
   * 材料明细末尾的「其它」行（用户 2026-10-08：「材料明细最后还需要加一个『其它』，可以自行添加类目。
   * 有时候还需要别的物料。允许用户增删改」）。
   *
   * 与上面 18 个固定栏位不同：这些行的**条数与类目名都是用户自己定的**，所以是一个数组而不是
   * 一格一个 state —— 增、删、改都只动这个数组，保存时整块发出去（后端也是整块替换语义）。
   */
  const [extras, setExtras] = useState<MaterialExtraRow[]>([]);
  const [materials, setMaterials] = useState<MaterialOption[]>([]);
  // 货号候选（老板 2026-09-26 的「货号」字段）：来自 GET /sales-orders/item-nos。
  // 拉不到就降级成空列表 —— 输入框仍然能输新货号，**不能**因为建议列表失败把整单卡住。
  const [itemNoSuggestions, setItemNoSuggestions] = useState<ItemNoSuggestion[]>([]);
  /** 返单来源（预览成功后才有）：来源单号 + id（跳来源单用）+ 货号（横幅上显示「同货号」）。 */
  const [reorderSource, setReorderSource] = useState<{ order_no: string; order_id: string; item_no: string } | null>(null);
  /**
   * 复制来源（快照拉成功后才有）：来源单号 + id（横幅与「查看来源单」用）+ 被剔掉的失效物料栏位。
   * 与 `reorderSource` 分开两个 state：编辑态返单横幅读的是单子上记着的来源，而复制**不记来源**，
   * 混用一个 state 迟早会出现「复制完的新单被显示成返单」。
   */
  const [copySource, setCopySource] = useState<{ order_no: string; order_id: string; dropped: string[] } | null>(null);
  /**
   * 复制过来的 `extension_data`。
   *
   * 为什么单独存一份：表单里没有 `extension_data` 的编辑格（新建/编辑都不发这个键 = 后端用默认 `{}`
   * 或保持原值）。复制这条路如果也不发，来源单上的扩展数据就在新单里静默消失了 ——
   * 而这正是"整单导入"被要求的原因（订单描述基本一样）。只在复制模式下带上，其余路径行为不变。
   */
  const [copiedExtensionData, setCopiedExtensionData] = useState<Record<string, unknown> | undefined>(undefined);
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

  /**
   * 把「复制过来的那一份」**一次性**灌进各块 state —— 返单与普通复制共用这一处。
   *
   * 为什么必须一次性（而不是逐键 set）：逐键 set 会与 `setBaseField` 的浅合并产生竞态，
   * 出现「填了一半」的表单 —— 而填了一半的表单最危险：销售以为工艺已经带过来了，
   * 直接存下去就是一张缺工艺的单。
   *
   * 为什么两条路共用一个函数：后端 `reorderPreview` 与 `copySnapshot` 的 `copy` 是**同一份清单、
   * 同一套请求键**。分两处写，必然有一处先漂移，而漂移的表现是"返单带过来了、复制少带一块"——
   * 这种错没人会当场发现（少的那一格是空的，看起来就是本来没填）。
   */
  function applyCopiedPayloadInternal(payload: { customer_id?: string | null; contact_id?: string | null; item_no?: string | null; copy?: Record<string, unknown> }) {
    const copy = (payload.copy ?? {}) as Record<string, unknown>;
    const text = (value: unknown) => (value === null || value === undefined ? "" : String(value));
    setBase({
      // 必须重填的四格**留空**：来源单的订单号/数量/下单日/交期属于上一张单，抄过来就是错的下单数据。
      // 页面上它们带「（复制后必填）」/「（返单必填）」提示（见 MUST_FILL_FIELDS）。
      order_no: "", order_date: "", quantity: "", delivery_date: "",
      customer_id: text(payload.customer_id),
      contact_id: text(payload.contact_id),
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
      // 货号：复制在 `copy.item_no`（清单的一部分），返单在顶层（横幅要显示它）。
      item_no: text(copy.item_no ?? payload.item_no),
      // 总金额/应收/本币金额**故意不预填**：它们由数量派生，抄过来必然与新数量矛盾。
    });
    // `copy` 用的是**请求键**（与快照同形状），正好是 `specFromOrder` 认的第一种形状。
    setSpec(specFromOrder(copy));
    const detailRows = Array.isArray(copy.spec_details) ? (copy.spec_details as Array<Record<string, unknown>>).map((row) => ({ group_name: text(row.group_name), name: text(row.name), color: text(row.color), barcode: text(row.barcode), quantity: text(row.quantity), unit: text(row.unit) })) : [];
    setDetails(detailRows.length ? detailRows : [emptySpecDetailRow()]);
    // 引用照抄：快照带了物料摘要（`material_refs[].material`），所以能直接把芯片显示出来，
    // 不依赖物料池那一次请求成不成功。
    setRefs(materialRefsFromOrder({ material_refs: copy.material_refs }));
    // 「其它」行跟着来源单（复制就是把上一批的完整材料口径带过来）。
    setExtras(materialExtrasFromOrder(copy));
    // 明细列名跟着来源单（列名属于工艺口径的一部分）。
    setDetailLabelOverrides(specDetailLabelsFromOrder(copy));
    // 扩展数据：表单里没有它的输入格，只有复制这条路能把它带过去（见 `copiedExtensionData` 的注释）。
    setCopiedExtensionData((copy.extension_data as Record<string, unknown> | undefined) ?? undefined);
  }

  /**
   * `useCallback(..., [])`：函数体只用 state 的 **setter**（React 保证稳定），不读任何 state ——
   * 所以身份固定，`load` 把它放进依赖数组也不会每次渲染都重建（那会让 `useEffect` 无限重跑）。
   */
  const applyCopiedPayload = useCallback(applyCopiedPayloadInternal, []);

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
        // 「其它」行（接口给的是列名形状 `materialExtras`，函数里两种键名都认）。
        setExtras(materialExtrasFromOrder(order));
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
        // 返单：先拉预览，再交给 `applyCopiedPayload` **一次性**灌进各块 state（理由见那个函数）。
        const preview = (await apiGet<ReorderPreview>(`/sales-orders/reorder-preview?order_no=${encodeURIComponent(reorderFromOrderNo)}`)).data;
        applyCopiedPayload(preview);
        setReorderSource({ order_no: preview.source_order_no, order_id: preview.source_order_id, item_no: String(preview.item_no ?? "") });
      } else if (copyFromId) {
        /**
         * 普通复制：拉快照 → 一次性预填。
         *
         * 与返单**同一套灌法**（同一个 `applyCopiedPayload`），差别只在来源：这条路没有三条门槛
         * （不限状态、不要求货号），也**不写来源**（保存载荷里没有 `reorder_from_order_no`）。
         * 失效物料由服务端在快照里就剔掉了（客户端没有"重选"这个动作），剔掉什么挂在横幅上说明。
         */
        const snapshot = (await apiGet<CopySnapshot>(`/sales-orders/${copyFromId}/copy-snapshot`)).data;
        applyCopiedPayload(snapshot);
        setCopySource({
          order_no: snapshot.source_order_no,
          order_id: snapshot.source_order_id,
          dropped: [...(snapshot.dropped?.material_refs ?? []), ...(snapshot.dropped?.material_extras ?? [])],
        });
      }
    } catch (cause) {
      // 返单预览 / 复制快照失败**必须出错误态**，不能退化成空表单：空表单会让销售以为
      // 「这单本来就没工艺要求」，直接存下去就是一张缺工艺的下单。
      setError(errorOf(cause, reorderMode
        ? "返单来源加载失败：请回到【返单与总结】重试，或新建普通销售单"
        : copyMode ? "复制来源加载失败：请回到销售单列表重试，或新建普通销售单" : "销售单数据加载失败"));
    } finally {
      setLoading(false);
    }
  }, [orderId, reorderFromOrderNo, reorderMode, copyFromId, copyMode, applyCopiedPayload]);

  useEffect(() => { void load(); }, [load]);

  const quantityNotice = useMemo(() => specQuantityNotice(base.quantity ?? "", base.unit ?? "", details), [base.quantity, base.unit, details]);
  const detailErrors = useMemo(() => validateSpecDetails(details), [details]);
  /** 「其它」行的逐行错误（与后端 `normalizeMaterialExtras` 同一套口径）：页面上先摆出来，保存前再拦一刀。 */
  const extraErrors = useMemo(() => validateMaterialExtras(extras), [extras]);
  /** 当前生效的列名（默认名 + 这一单的覆盖）：表头、行内 aria-label、改列名弹窗都用它。 */
  const detailLabels = useMemo(() => detailLabelsWithDefaults(detailLabelOverrides), [detailLabelOverrides]);
  // 引用下拉的选项（label = `编码 / 名称 规格 颜色`，与全站物料选择器同一份文字口径）。
  // 搜索由 `SearchableSelect` 内部按 label 子串过滤 —— 所以「按编码」「按名称」「按规格」「按颜色」都能搜到。
  const materialOptions = useMemo(() => materials.map((material) => ({ value: material.id, label: materialOptionLabel(material) })), [materials]);
  const selectedCustomer = customers.find((item) => item.id === base.customer_id);
  const contacts = selectedCustomer?.contacts ?? [];

  const setBaseField = (key: string, value: string) => setBase((current) => ({ ...current, [key]: value }));
  const setDetailField = (index: number, key: string, value: string) => setDetails((current) => current.map((row, at) => (at === index ? { ...row, [key]: value } : row)));
  const setExtraField = (index: number, key: "label" | "content", value: string) => setExtras((current) => current.map((row, at) => (at === index ? { ...row, [key]: value } : row)));
  /** 删掉一行「其它」：用户要的就是"允许增删改"，所以不保留任何占位（与明细那行的「最后一行空行」规则不同）。 */
  const removeExtra = (index: number) => setExtras((current) => current.filter((_row, at) => at !== index));

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
   * 「其它」行引用一个物料（同一套可搜索下拉 + 缩略图）。
   *
   * 与上面 18 格**故意有一点不同**：只在内容格为空时预填「名称 规格 颜色」。18 格是模板上印死的
   * 固定栏位（每一格就是那一个部件的规格，选中就是替人省掉手打），而「其它」行的内容是人手写的
   * 自由文本（可能写着「弹簧 5cm 不锈钢（按上次那批）」之类工厂要照做的话）—— 无条件覆盖等于把
   * 那句话悄悄改掉。引用本身照记：它决定缩略图与导出时能不能带上这张图。
   */
  function pickExtraMaterial(index: number, materialId: string) {
    const material = materials.find((item) => item.id === materialId) ?? null;
    setExtras((current) => current.map((row, at) => (at === index ? { ...row, material, content: row.content.trim() || !material ? row.content : materialSpecText(material) } : row)));
  }
  /** 取消「其它」行的引用：与 18 格同一条口径 —— 只摘掉引用，不动文字。 */
  function clearExtraRef(index: number) {
    setExtras((current) => current.map((row, at) => (at === index ? { ...row, material: null } : row)));
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
    // 「其它」行同一套逐行拦截（后端也会拒，但让用户当场看见是哪一行）。
    if (extraErrors.length) { setError(`「其它」第 ${extraErrors[0].row} 行：${extraErrors[0].reason}`); return; }
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
    const payload: Record<string, unknown> = { ...base, ...specPayload(spec, details, refs, detailLabelOverrides, extras) };
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
    } else if (copySource) {
      /**
       * 复制这条路**故意什么都不写**。
       *
       * 不写 `reorder_from_order_no` 是用户拍板的口径：写了新单就会被【返单与总结】归进返单分组，
       * 销售会以为这是客户返单（复制只是"照着上一张改细节"，与客户返单是两件事）。
       * 这也是后端 `copySnapshot` 返回里根本没有来源键的原因 —— 两处一起挡，不靠"前端记得别写"。
       *
       * 唯一要显式带的是 `extension_data`：表单里没有它的输入格，不带就等于复制时静默丢掉
       * （见 `copiedExtensionData` 的注释）。
       */
      if (copiedExtensionData !== undefined) payload.extension_data = copiedExtensionData;
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
   * 返单预览 / 复制快照拉不到时**不渲染表单**。
   *
   * 只在错误横幅下面留一张空白表单是不够的：空白表单看起来就是「这一单本来就没有工艺要求」，
   * 销售填几个数直接存下去，得到的是一张缺工艺的下单 —— 而这两条路的全部意义就是沿用上一张的工艺。
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
  if (copyMode && !copySource) {
    return (
      <div className="page-root" data-testid="sales-order-editor">
        <PageHeader title="新建销售单（复制）" breadcrumb={["客户与销售", "销售单"]} />
        <section className="panel"><ErrorState message={error || "复制来源加载失败"} onRetry={() => void load()} /></section>
        <section className="panel panel-body"><Button variant="secondary" onClick={() => router.push("/sales/orders")}>返回销售单列表</Button></section>
      </div>
    );
  }

  return (
    <div className="page-root" data-testid="sales-order-editor">
      <PageHeader title={editing ? `编辑销售单 ${base.order_no ?? ""}` : copyMode ? "新建销售单（复制）" : "新建销售单"} breadcrumb={["客户与销售", "销售单"]}>
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

      {/* 复制横幅：说清"由谁复制"、哪几格要重填，以及**新单不记来源**（见 CopyBanner 的注释）。 */}
      <CopyBanner sourceOrderNo={copySource?.order_no ?? ""} sourceOrderId={copySource?.order_id} dropped={copySource?.dropped} />
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
              {/*
                这两条路进来的四格必须重填：来源单的数量/日期是上一张单的口径（后端 must_fill 同一份清单）。
                标记分开成两个 testid，是因为文案不同 —— 返单的"同货号"语境与复制的"不记来源"语境不是一回事，
                混用一个 testid 会让「复制模式错显示了返单横幅」这类问题测不出来。
              */}
              {reorderMode && MUST_FILL_FIELDS.has(field.key)
                ? <span className="reorder-must-fill" data-testid={`reorder-must-fill-${field.key}`}>（返单必填）</span>
                : copyMode && MUST_FILL_FIELDS.has(field.key)
                  ? <span className="reorder-must-fill" data-testid={`copy-must-fill-${field.key}`}>（复制后必填）</span>
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
          <span className="panel-note">两张样本的并集共 18 项；留空的项导出时不印该行。每一格<strong>既可以手打文字，也可以从物料清单里引用一个物料</strong>（选中会把名称/规格/颜色填进格子，并带上它的图片）。模板以外的物料写在下面的「其它」里。</span>
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
        {/*
          「其它」（用户 2026-10-08：「材料明细最后还需要加一个『其它』，可以自行添加类目。有时候还需要
          别的物料。允许用户增删改」）。
          放在 18 格**同一块面板里**、紧跟着它们：用户说的位置就是「材料明细最后」—— 另起一块面板会让人
          以为是另一个业务对象。每一行是「类目 + 内容 + 引用」（与 18 格同一套选择器与缩略图）。
        */}
        <div className="panel-body material-extra-block">
          <div className="panel-heading">
            <h3>其它</h3>
            <span className="panel-note">模板上那 18 项以外的物料写在这里：类目名自己起（弹簧 / 螺丝 / 胶袋…），内容可以手打，也可以像上面一样从物料清单引用（带缩略图，导出时能勾选把图带上）。类目与内容都空的行不会被保存，导出也不印。</span>
            <Button
              size="sm"
              variant="secondary"
              data-testid="sales-material-extra-add"
              disabled={extras.length >= MATERIAL_EXTRA_LIMIT}
              onClick={() => setExtras((current) => [...current, emptyMaterialExtraRow()])}
            >加一行</Button>
          </div>
          {extraErrors.length > 0 && <div className="status-error" data-testid="sales-material-extra-errors">{extraErrors.map((item) => <p key={`${item.row}-${item.reason}`}>第 {item.row} 行：{item.reason}</p>)}</div>}
          {extras.length === 0 && <p className="panel-note" data-testid="sales-material-extra-empty">还没有自定义类目 —— 只在需要模板 18 项以外的物料时才点右上角的「加一行」。</p>}
          {extras.map((row, index) => {
            const material = row.material;
            return (
              <div key={index} className="material-extra-row form-grid" data-testid={`sales-material-extra-row-${index}`}>
                <label>类目
                  <Input data-testid={`sales-material-extra-label-${index}`} value={row.label} placeholder="例如：弹簧" onChange={(event) => setExtraField(index, "label", event.target.value)} />
                </label>
                <label>内容
                  <textarea className="ui-input" rows={2} data-testid={`sales-material-extra-content-${index}`} value={row.content} placeholder="规格说明；引用了物料之后可以留空（导出会用物料摘要印出来）" onChange={(event) => setExtraField(index, "content", event.target.value)} />
                </label>
                <div className="action-row">
                  <SearchableSelect
                    testId={`sales-material-extra-ref-${index}`}
                    value={material?.id ?? ""}
                    options={materialOptions}
                    onChange={(value) => pickExtraMaterial(index, value)}
                    placeholder="从物料清单引用…"
                    label={`其它第 ${index + 1} 行（${row.label || "未填类目"}）：从物料清单引用`}
                    searchPlaceholder="输入物料编码 / 名称 / 规格 / 颜色搜索"
                    noResultsText="没有匹配的物料（可到【采购 → 物料清单】新建）"
                  />
                  {material && <MaterialThumb materialId={material.id} version={material.image?.sha256} alt={materialOptionLabel(material)} size={36} />}
                  {material && <Button size="sm" variant="ghost" data-testid={`sales-material-extra-ref-clear-${index}`} onClick={() => clearExtraRef(index)}>清除引用</Button>}
                  <Button size="sm" variant="ghost" data-testid={`sales-material-extra-remove-${index}`} onClick={() => removeExtra(index)}>删除这一行</Button>
                </div>
                {/* 与 18 格同一条提示：引用了但那个物料没有图，导出时这一行没有图可带。 */}
                {material && !material.image && <span className="panel-note" data-testid={`sales-material-extra-no-image-${index}`}>该物料还没有图片（可到【采购 → 物料清单】上传）</span>}
              </div>
            );
          })}
          {extras.length >= MATERIAL_EXTRA_LIMIT && <p className="panel-note" data-testid="sales-material-extra-limit">已经 {extras.length} 行，到上限 {MATERIAL_EXTRA_LIMIT} 行了（工艺单是一张 A4 纸，再多就印不下）。</p>}
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
