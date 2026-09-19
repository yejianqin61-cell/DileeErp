"use client";

// 销售单整页编辑器（2026-09-16 下单口径细化）。
//
// 为什么把「新建销售单」从弹窗改成整页：细化后光固化字段就有 37 个（材料 18 + 工艺 9 + 布量 5 +
// 表头 5）外加一张可增删的明细表，弹窗（ActionDialog）放不下——这是用户拍板的选择。
//
// 字段清单与载荷规则全部来自 `lib/sales-order-spec.ts`（纯函数，有 node:test 覆盖），
// 这个组件只负责渲染与取数，不再自己拼字段名——否则清单会分叉成「界面有、库里没有」。
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { PageHeader } from "../layout/app-shell";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { ErrorState, LoadingState } from "../feedback/states";
import { notifyError, notifySuccess } from "../ui/toaster";
import { ApiClientError, apiGet, apiPatch, apiPost } from "../../lib/api-client";
import { fetchCurrencyOptions, currencyOptionsWithCurrent, type CurrencyOption } from "../../lib/currency-catalogue";
import { auditDetailFields, type AuditRow } from "../data/audit-columns";
import {
  SPEC_DETAIL_COLUMNS, SPEC_FABRIC_FIELDS, SPEC_HEADER_FIELDS, SPEC_MATERIAL_FIELDS, SPEC_PROCESS_FIELDS,
  SPEC_SCALAR_KEYS, emptySpecDetailRow, isBlankSpecDetail, specPayload, specQuantityNotice, validateSpecDetails, type SpecDetailRow,
} from "../../lib/sales-order-spec";

type Customer = { id: string; customerCode?: string; name: string; isActive?: boolean; currency?: string | null; contacts?: Array<{ id: string; name: string; phone?: string | null; isDefault?: boolean }> };
type Unit = { id: string; name: string };
type DetailResponse = AuditRow & Record<string, unknown> & { id: string; orderNo: string; status: string; customer?: { id: string }; contact?: { id: string } | null; specDetails?: Array<Record<string, unknown>> };

/** 基础字段：与弹窗时代同一批（口径没变，只是换了个更能装的形式）。 */
const BASE_FIELDS: ReadonlyArray<{ key: string; label: string; type?: "textarea" | "date" | "number"; required?: boolean }> = [
  { key: "order_no", label: "订单号", required: true },
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

const errorOf = (cause: unknown, fallback: string) => (cause instanceof ApiClientError ? cause.message : fallback);

export function SalesOrderEditor({ orderId }: { orderId?: string }) {
  const router = useRouter();
  const editing = Boolean(orderId);
  const [base, setBase] = useState<Record<string, string>>({ order_date: new Date().toISOString().slice(0, 10), quantity: "1" });
  const [spec, setSpec] = useState<Record<string, string>>({});
  const [details, setDetails] = useState<SpecDetailRow[]>([emptySpecDetailRow()]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [units, setUnits] = useState<Unit[]>([]);
  const [currencies, setCurrencies] = useState<CurrencyOption[]>([]);
  const [audit, setAudit] = useState<AuditRow | null>(null);
  const [status, setStatus] = useState("draft");
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [customerList, unitList, currencyList] = await Promise.all([
        apiGet<Customer[]>("/customers?page_size=200"),
        apiGet<Unit[]>("/units"),
        fetchCurrencyOptions().catch(() => [] as CurrencyOption[]),
      ]);
      setCustomers(customerList.data.filter((item) => item.isActive !== false));
      setUnits(unitList.data);
      setCurrencies(currencyList);
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
        });
        const loadedSpec: Record<string, string> = {};
        for (const key of SPEC_SCALAR_KEYS) loadedSpec[key] = asText(order[key]);
        setSpec(loadedSpec);
        const rows = (order.specDetails ?? []).map((row) => ({
          group_name: String(row.groupName ?? ""), name: String(row.name ?? ""), color: String(row.color ?? ""),
          barcode: String(row.barcode ?? ""), quantity: asText(row.quantity), unit: String(row.unit ?? ""),
        }));
        setDetails(rows.length ? rows : [emptySpecDetailRow()]);
        setAudit(order);
        setStatus(String(order.status ?? "draft"));
      }
    } catch (cause) {
      setError(errorOf(cause, "销售单数据加载失败"));
    } finally {
      setLoading(false);
    }
  }, [orderId]);

  useEffect(() => { void load(); }, [load]);

  const quantityNotice = useMemo(() => specQuantityNotice(base.quantity ?? "", base.unit ?? "", details), [base.quantity, base.unit, details]);
  const detailErrors = useMemo(() => validateSpecDetails(details), [details]);
  const selectedCustomer = customers.find((item) => item.id === base.customer_id);
  const contacts = selectedCustomer?.contacts ?? [];

  const setBaseField = (key: string, value: string) => setBase((current) => ({ ...current, [key]: value }));
  const setDetailField = (index: number, key: string, value: string) => setDetails((current) => current.map((row, at) => (at === index ? { ...row, [key]: value } : row)));

  async function save() {
    if (!base.order_no?.trim()) { setError("订单号必填"); return; }
    if (!base.customer_id) { setError("请选择客户"); return; }
    if (!base.product_name?.trim()) { setError("产品名称必填"); return; }
    if (!base.quantity?.trim()) { setError("数量必填"); return; }
    if (!base.unit?.trim()) { setError("请选择单位"); return; }
    if (!base.currency?.trim()) { setError("请选择币种"); return; }
    if (!base.order_date?.trim()) { setError("下单日期必填"); return; }
    if (detailErrors.length) { setError(`明细第 ${detailErrors[0].row} 行：${detailErrors[0].reason}`); return; }
    if (editing && status === "confirmed" && !reason.trim()) { setError("已确认销售单修改必须填写原因"); return; }

    setSaving(true);
    setError("");
    const payload: Record<string, unknown> = { ...base, ...specPayload(spec, details) };
    // 基础字段的空串当「没填」删掉：可选字段的 @IsDecimal/@IsDateString 会因为空串报 400。
    // 细化字段相反——空串 = 清除这一格，必须原样发出去（`specPayload` 已经把 37 个键都带上了）。
    for (const key of Object.keys(base)) if (base[key] === "" && !SPEC_SCALAR_KEYS.includes(key)) delete payload[key];
    if (editing) {
      // 订单号与客户不可改（后端也是这么要求的：update 不接受这两个键）。
      delete payload.order_no;
      delete payload.customer_id;
      payload.reason = reason.trim() || undefined;
    }
    try {
      const saved = editing
        ? (await apiPatch<{ id: string; orderNo: string }>(`/sales-orders/${orderId}`, payload)).data
        : (await apiPost<{ id: string; orderNo: string }>("/sales-orders", payload)).data;
      notifySuccess(editing ? "销售单已保存" : `销售单已创建（${saved.orderNo}）`);
      router.push("/sales");
    } catch (cause) {
      // 保存失败留在页面上：用户填的 37 格 + 明细不能因为一次网络抖动白填。
      setError(errorOf(cause, "保存失败"));
      notifyError(errorOf(cause, "保存失败"));
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div className="page-root" data-testid="sales-order-editor"><PageHeader title={editing ? "编辑销售单" : "新建销售单"} breadcrumb={["销售", "销售单"]} /><LoadingState /></div>;

  return (
    <div className="page-root" data-testid="sales-order-editor">
      <PageHeader title={editing ? `编辑销售单 ${base.order_no ?? ""}` : "新建销售单"} breadcrumb={["销售", "销售单"]}>
        <Button variant="secondary" onClick={() => router.push("/sales")} disabled={saving}>取消</Button>
        <Button onClick={() => void save()} disabled={saving} data-testid="sales-order-save">{saving ? "保存中…" : "保存"}</Button>
      </PageHeader>
      {error && <section className="panel"><ErrorState message={error} onRetry={() => void load()} /></section>}

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
          {BASE_FIELDS.map((field) => (
            <label key={field.key}>{field.label}{field.required ? "（必填）" : ""}
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
        <div className="panel-heading"><h2>材料明细</h2><span className="panel-note">两张样本的并集共 18 项；留空的项导出时不印该行</span></div>
        <div className="panel-body form-grid">
          {SPEC_MATERIAL_FIELDS.map(([key, label]) => (
            <label key={key}>{label}
              <textarea className="ui-input" rows={2} data-testid={`sales-spec-${key}`} value={spec[key] ?? ""} onChange={(event) => setSpec((current) => ({ ...current, [key]: event.target.value }))} />
            </label>
          ))}
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
          <span className="panel-note">一张通用表：用「分组名」区分（伞布明细 / 伞头配色 / 外层花色搭配…）；图片不录入、导出留空</span>
          <Button size="sm" variant="secondary" data-testid="sales-detail-add" onClick={() => setDetails((current) => [...current, emptySpecDetailRow()])}>加一行</Button>
        </div>
        <div className="panel-body">
          {quantityNotice && <p className="status-warning" data-testid="sales-quantity-notice">{quantityNotice}</p>}
          {detailErrors.length > 0 && <div className="status-error" data-testid="sales-detail-errors">{detailErrors.map((item) => <p key={`${item.row}-${item.reason}`}>第 {item.row} 行：{item.reason}</p>)}</div>}
          <div className="table-wrap">
            <table className="ui-table">
              <thead><tr>{SPEC_DETAIL_COLUMNS.map(([, label]) => <th key={label}>{label}</th>)}<th>操作</th></tr></thead>
              <tbody>
                {details.map((row, index) => (
                  <tr key={index} data-testid={`sales-detail-row-${index}`}>
                    {SPEC_DETAIL_COLUMNS.map(([key, label]) => (
                      <td key={key}>
                        <Input aria-label={label} data-testid={`sales-detail-${index}-${key}`} value={row[key as keyof SpecDetailRow]} onChange={(event) => setDetailField(index, key, event.target.value)} />
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
