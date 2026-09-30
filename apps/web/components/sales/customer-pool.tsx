"use client";

// 销售二级页：客户池（客户主数据 + 联系人）。
//
// 与改造前的关系：这段逻辑原来长在 `app/sales/page.tsx` 里（销售页顶部三张表之一），
// 现在整段搬进独立页面 —— 行为一字未改（同一个 `/customers?page_size=200`、同一个 search 口径、
// 同一套新建/编辑/停用/删除与联系人 CRUD），只是不再与销售单、成品总览挤在一页里。
//
// 两条界面约定：
//   * 搜索框走 `lib/fuzzy-search` 的统一语义（「所有池子都要支持搜索」），联系人字段也摊平进来 ——
//     现场常常只记得联系人姓名或电话；
//   * 客户编码支持「自动生成 / 手动填写」（与物料/供应商一致）；编辑时只改编码本身。
import { useEffect, useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { PageHeader } from "../layout/app-shell";
import { ActionDialog, type ActionField } from "../ui/action-dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "../ui/sheet";
import { DataTable } from "../data/data-table";
import { EmptyState, ErrorState, LoadingState } from "../feedback/states";
import { ApiClientError, apiGet, apiPatch, apiPost, apiRequest } from "../../lib/api-client";
import { currencyOptionsWithCurrent, fetchCurrencyOptions, type CurrencyOption } from "../../lib/currency-catalogue";
import { fuzzyMatch } from "../../lib/fuzzy-search";
import { auditColumns, auditDetailFields, type AuditRow } from "../data/audit-columns";
import { notifyError, notifySuccess } from "../ui/toaster";

type Contact = { id: string; name: string; position?: string; phone?: string; email?: string; isDefault: boolean; isActive: boolean };
export type Customer = AuditRow & { id: string; customerCode: string; name: string; countryRegion?: string; address?: string; paymentTerms?: string; currency?: string; remark?: string; isActive: boolean; contacts: Contact[] };
type DialogState = { title: string; fields: ActionField[]; submit: (values: Record<string, string>) => void | Promise<void> };

const messageOf = (cause: unknown, fallback: string) => cause instanceof ApiClientError ? cause.message : fallback;

export default function CustomerPool({ testId = "page-sales-customers" }: { testId?: string }) {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [customerQuery, setCustomerQuery] = useState("");
  const [customerSelected, setCustomerSelected] = useState<Customer | null>(null);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [categoryDialog, setCategoryDialog] = useState<DialogState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // 币种来自可配置字典 GET /dictionaries/currency/items（失败回落内置清单），不写死 "USD"。
  const [currencyCatalogue, setCurrencyCatalogue] = useState<CurrencyOption[]>([]);

  // 币种是静态配置：独立 effect，客户列表刷新时不会重复拉取字典。
  useEffect(() => { let cancelled = false; void fetchCurrencyOptions().then((options) => { if (!cancelled) setCurrencyCatalogue(options); }); return () => { cancelled = true; }; }, []);

  async function load() {
    setLoading(true);
    setError("");
    try {
      setCustomers((await apiGet<Customer[]>("/customers?page_size=200")).data);
    } catch (cause) {
      setError(messageOf(cause, "客户数据加载失败"));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void load(); }, []);

  // 客户池的关键字搜索（用户 2026-09-16：「所有池子，都要支持搜索」）：与其它池子共用
  // lib/fuzzy-search 的匹配语义。联系人也要能搜到（现场常常只记得联系人姓名或电话），
  // 所以把每个联系人的姓名/职位/电话/邮箱都摊平进可搜索字段。
  const visibleCustomers = useMemo(() => customers.filter((item) => fuzzyMatch(customerQuery, [
    item.customerCode, item.name, item.countryRegion, item.address, item.paymentTerms, item.remark,
    ...item.contacts.flatMap((contact) => [contact.name, contact.position, contact.phone, contact.email]),
  ])), [customers, customerQuery]);

  async function run(action: () => Promise<unknown>, success: string) {
    setError("");
    try {
      await action();
      notifySuccess(success);
      await load();
    } catch (cause) {
      notifyError(messageOf(cause, "操作失败"));
    }
  }

  function openCustomer(customer?: Customer) {
    // 新建时支持“自动生成 / 手动填写”客户编码（与物料/供应商一致）；编辑时只改编码本身。
    const codeFields: ActionField[] = customer
      ? [{ name: "customer_code", label: "客户编码", required: true, defaultValue: customer.customerCode }]
      : [{ name: "code_mode", label: "编码方式", type: "select", required: true, defaultValue: "auto", options: [{ value: "auto", label: "自动生成" }, { value: "manual", label: "手动填写" }] }, { name: "customer_code", label: "客户编码", placeholder: "自动生成时留空" }];
    setCategoryDialog({
      title: customer ? "编辑客户" : "新建客户",
      fields: [...codeFields, { name: "name", label: "客户名称", required: true, defaultValue: customer?.name }, { name: "country_region", label: "国家/地区", defaultValue: customer?.countryRegion }, { name: "address", label: "地址", type: "textarea", defaultValue: customer?.address }, { name: "payment_terms", label: "付款条件", defaultValue: customer?.paymentTerms }, { name: "currency", label: "币种", type: "select", options: currencyOptionsWithCurrent(currencyCatalogue, customer?.currency), defaultValue: customer?.currency ?? "USD" }, { name: "remark", label: "备注", type: "textarea", defaultValue: customer?.remark }],
      submit: async (v) => {
        if (!customer && v.code_mode === "manual" && !v.customer_code?.trim()) { setError("手动编码模式必须填写客户编码"); return; }
        const payload = customer ? { ...v, code_mode: undefined } : { ...v, code_mode: v.code_mode || "auto", customer_code: v.customer_code?.trim() || undefined };
        const result = customer ? await apiPatch<{ id: string; customerCode?: string }>(`/customers/${customer.id}`, payload) : await apiPost<{ id: string; customerCode?: string }>("/customers", payload);
        await load();
        setCategoryDialog(null);
        notifySuccess(customer ? "客户已更新" : v.code_mode === "manual" ? "客户已创建" : `客户已创建（编码 ${result.data.customerCode ?? "自动生成"}）`);
      },
    });
  }

  function openContact(customer: Customer, contact?: Contact) {
    setDialog({
      title: contact ? "编辑联系人" : "新增联系人",
      fields: [{ name: "name", label: "姓名", required: true, defaultValue: contact?.name }, { name: "position", label: "职位", defaultValue: contact?.position }, { name: "phone", label: "电话", defaultValue: contact?.phone }, { name: "email", label: "邮箱", defaultValue: contact?.email }, { name: "remark", label: "备注", type: "textarea", defaultValue: "" }],
      submit: async (v) => {
        if (contact) await apiPatch(`/customers/${customer.id}/contacts/${contact.id}`, v);
        else await apiPost(`/customers/${customer.id}/contacts`, v);
        await load();
        setDialog(null);
        notifySuccess(contact ? "联系人已更新" : "联系人已创建");
      },
    });
  }

  function deactivateCustomer(customer: Customer) { void run(() => apiPatch(`/customers/${customer.id}/active`, { is_active: !customer.isActive }), customer.isActive ? "客户已停用" : "客户已启用"); }
  function deleteCustomer(customer: Customer) { void run(() => apiRequest(`/customers/${customer.id}`, { method: "DELETE" }), "客户已停用并保留审计记录"); }

  const customerColumns: ColumnDef<Customer>[] = [
    { accessorKey: "customerCode", header: "编码" },
    { accessorKey: "name", header: "客户" },
    { accessorKey: "countryRegion", header: "国家/地区" },
    { id: "contacts", header: "联系人", cell: ({ row }) => row.original.contacts.length },
    { id: "status", header: "状态", cell: ({ row }) => row.original.isActive ? "启用" : "停用" },
    ...auditColumns<Customer>(),
    { id: "actions", header: "操作", cell: ({ row }) => <div className="action-row"><Button size="sm" variant="secondary" onClick={() => setCustomerSelected(row.original)}>详情</Button><Button size="sm" variant="ghost" onClick={() => openCustomer(row.original)}>编辑</Button><Button size="sm" variant="ghost" onClick={() => deactivateCustomer(row.original)}>{row.original.isActive ? "停用" : "启用"}</Button><Button size="sm" variant="ghost" onClick={() => deleteCustomer(row.original)}>删除</Button></div> },
  ];

  if (loading) return <div className="page-root" data-testid={testId}><PageHeader title="客户池" breadcrumb={["客户与销售", "客户池"]} /><LoadingState /></div>;

  return <div className="page-root" data-testid={testId}>
    <PageHeader title="客户池" breadcrumb={["客户与销售", "客户池"]} description="客户主数据与联系人。">
      <Button variant="secondary" data-testid="customer-new" onClick={() => openCustomer()}>新建客户</Button>
    </PageHeader>
    <ActionDialog open={Boolean(dialog)} onOpenChange={(open) => { if (!open) setDialog(null); }} title={dialog?.title ?? "操作"} fields={dialog?.fields ?? []} onSubmit={async (values) => { await dialog?.submit(values); setDialog(null); }} />
    <ActionDialog open={Boolean(categoryDialog)} onOpenChange={(open) => { if (!open) setCategoryDialog(null); }} title={categoryDialog?.title ?? "新建客户"} fields={categoryDialog?.fields ?? []} onSubmit={(values) => { void categoryDialog?.submit(values); }} />
    {error && <section className="panel"><ErrorState message={error} onRetry={() => void load()} /></section>}
    <section className="panel">
      <div className="panel-heading"><h2>客户池</h2><span className="panel-note" data-testid="customer-count">共 {customers.length} 个客户（启用 {customers.filter((item) => item.isActive).length} 个），当前列出 {visibleCustomers.length} 条</span></div>
      <div className="panel-body">
        <div className="filter-bar"><label>搜索客户编码、名称、联系人或国家/地区<Input data-testid="customer-search" value={customerQuery} onChange={(event) => setCustomerQuery(event.target.value)} placeholder="输入关键词，空格分隔多个词" /></label></div>
        <DataTable columns={customerColumns} data={visibleCustomers} empty={customerQuery.trim() ? <EmptyState title={`没有匹配“${customerQuery.trim()}”的客户`} description={`共 ${customers.length} 个客户，换个关键词或清空搜索框。`} /> : <EmptyState title="暂无客户" />} />
      </div>
    </section>
    <Sheet open={Boolean(customerSelected)} onOpenChange={(open) => { if (!open) setCustomerSelected(null); }}>
      <SheetContent>
        <SheetHeader><SheetTitle>{customerSelected?.name}</SheetTitle><SheetDescription>客户与联系人</SheetDescription></SheetHeader>
        {customerSelected && <div className="detail-list">
          <p>编码：{customerSelected.customerCode}</p>
          <p>地址：{customerSelected.address || "-"}</p>
          <p>付款条件：{customerSelected.paymentTerms || "-"}</p>
          {auditDetailFields(customerSelected).map((field) => <p key={field.label}>{field.label}：{field.value}</p>)}
          <h3>联系人</h3>
          {customerSelected.contacts.map((contact) => <div className="contact-block" key={contact.id}>
            <p>{contact.name}{contact.isDefault ? "（默认）" : ""}</p>
            <p>{contact.position || ""} {contact.phone || ""} {contact.email || ""}</p>
            <div className="page-actions">
              <Button size="sm" variant="ghost" onClick={() => openContact(customerSelected, contact)}>编辑</Button>
              <Button size="sm" variant="ghost" onClick={() => void run(() => apiRequest(`/customers/${customerSelected.id}/contacts/${contact.id}`, { method: "DELETE" }), "联系人已删除")}>删除</Button>
            </div>
          </div>)}
          <Button size="sm" variant="secondary" onClick={() => openContact(customerSelected)}>新增联系人</Button>
        </div>}
      </SheetContent>
    </Sheet>
  </div>;
}
