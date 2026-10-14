"use client";

import { useEffect, useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { PageHeader } from "../../../components/layout/app-shell";
import { ActionDialog, type ActionField } from "../../../components/ui/action-dialog";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { DataTable } from "../../../components/data/data-table";
import { EmptyState, ErrorState, LoadingState } from "../../../components/feedback/states";
import { auditColumns, type AuditRow } from "../../../components/data/audit-columns";
import { ApiClientError, apiGet, apiPost, apiRequest } from "../../../lib/api-client";
import { fuzzyMatch } from "../../../lib/fuzzy-search";
import { notifyError, notifySuccess } from "../../../components/ui/toaster";

type Reference = AuditRow & { id: string; supplierCode?: string; code?: string; name?: string; contactName?: string | null; phone?: string | null; address?: string | null; remark?: string | null; isActive?: boolean };

const messageOf = (cause: unknown, fallback: string) => cause instanceof ApiClientError ? cause.message : fallback;

/**
 * 供应商池的列宽（2026-10-09：`DataTable` 一律 `table-layout: fixed`，没写宽度的列由浏览器**均分**，
 * 所以这里把「均分」换成「按内容需要分配」）。
 *
 * 口径与 `app/procurement/inbounds/page.tsx` 同一套，两个常数先记住：
 *   - 可用宽度基线 **1034px**（1366 视口减侧栏后的实测表宽）；
 *   - `.ui-table-cell` 左右各 12px 内边距 → 一列定 n% 后真正能放字的宽度是 `n% × 1034 - 24`
 *     （8% → 58.7px，与 `components/data/audit-columns.tsx:44` 记的实测值一致）。
 *
 * 本表 10 列 = 8 列业务列（含「操作」）+ `auditColumns()` 的「创建人 / 最后修改人」。
 * 后两列**刻意不给宽度、也不改工厂用法**（`lib/audit-columns-coverage.test.mjs` 有守卫），
 * 所以下面 8 个数字的总和必须是 **84%**，剩下 16% 由那两列均分（各 8% = 58.7px，正好是工厂注释里的宽度）。
 */
const COLUMN_WIDTH = {
  // 供应商编码：`SP-2026-0001` 一类 12 字符 ≈ 90px（需求 8.7%），但 84% 要分给 8 列，
  // 规则下限就是 8%；长出来的靠「cell-ellipsis 省略 + hover 看全文」兜住。
  supplierCode: "8%",
  // 供应商名称：`深圳市恒达精密制造有限公司` 14 汉字 ≈ 168px，是全表最该看清的一列（需求 16%），
  // 按 84% 预算取 13%（= 110.4px，放得下 9 个汉字），超出部分 hover。
  name: "13%",
  // 联系人：姓名 2~4 汉字 ≈ 48px，加内边距 24px = 72px → 7%（= 48.4px），够放 4 个汉字。
  contactName: "7%",
  // 联系电话：`13800138000` 11 位数字 ≈ 73px，需求 9.4%，但按字数它是短列 —— 取 6%（= 38.1px），
  // 放不下整串，靠 hover 看全（这是本次「按内容需要分配」在 8 列预算下的既定取舍）。
  phone: "6%",
  // 地址：长自由文本，典型 `广东省深圳市宝安区……` 25 汉字 ≈ 300px（需求 29%）。
  // 它是本表最该宽的列，取 15%（= 131.1px，放得下 11 个汉字），全长 hover 可见。
  address: "13%",
  // 备注：同样是长自由文本（`月结 30 天，联系人休假请找王工……`），与「地址」等宽 15%。
  // 两列等宽是刻意的：它们都是「一眼看不完、要看就 hover」的同一类内容。
  remark: "13%",
  // 状态：只有「启用 / 停用」两个固定枚举（2 汉字 ≈ 24px），短状态 4%~6% 中按 4 汉字留量取 5%。
  status: "5%",
  // 操作列：3 个控件（编辑 / 启用|停用 / 删除）。
  // 按规则「每控件 44px + 间距 4px」：3 × 44 + 2 × 4 = 140px，加本格 24px 内边距 = 164px → 15.9%。
  // 为什么必须给够：`.action-row`（`globals.css:134`）是 `flex-wrap: wrap`，格子不够宽时按钮会
  // **叠成两三行**、把行高撑起来（而且没有任何省略号提示这件事）。15%（= 155.1px）配合 12px 字号下
  // 「编辑」≈ 42px /「启用」≈ 42px /「删除」≈ 42px（`ui-button-sm`：padding 0 10px），两行刚好放下三个。
  // 三个操作按钮保持一行，避免供应商列表每行因按钮换行而变高。
  actions: "19%",
} as const;

export default function SuppliersPage() {
  const [suppliers, setSuppliers] = useState<Reference[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  // 供应商池的关键字搜索（用户 2026-09-16：「供应商池，要支持搜索」）：
  // 与其它池子共用 lib/fuzzy-search 的匹配语义（多词 AND、忽略大小写与空白）。
  const [query, setQuery] = useState("");
  const [dialog, setDialog] = useState<{ title: string; fields: ActionField[]; submit: (values: Record<string, string>) => void } | null>(null);
  const [categoryDialog, setCategoryDialog] = useState<{ title: string; fields: ActionField[]; submit: (values: Record<string, string>) => void } | null>(null);

  // 可搜索的字段：编码（两种字段名）、名称、联系人、电话、地址、备注。
  const visible = useMemo(
    () => suppliers.filter((item) => fuzzyMatch(query, [item.supplierCode, item.code, item.name, item.contactName, item.phone, item.address, item.remark])),
    [suppliers, query],
  );

  async function load() {
    setLoading(true);
    setError("");
    try {
      const result = await apiGet<Reference[]>("/suppliers");
      setSuppliers(result.data);
    } catch (cause) {
      setError(messageOf(cause, "供应商数据加载失败"));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  async function action(path: string, body?: unknown, success = "操作已完成", method: "POST" | "PATCH" = "POST") {
    setError("");
    try {
      if (method === "PATCH") await apiRequest(path, { method, body: JSON.stringify(body) });
      else await apiPost(path, body);
      notifySuccess(success);
      await load();
    } catch (cause) {
      notifyError(messageOf(cause, "操作失败"));
    }
  }

  function openSupplier() {
    setCategoryDialog({
      title: "新建供应商",
      fields: [
        { name: "code_mode", label: "编码方式", type: "select", required: true, defaultValue: "auto", options: [{ value: "auto", label: "自动生成" }, { value: "manual", label: "手动填写" }] },
        { name: "supplier_code", label: "供应商编码", placeholder: "自动生成时留空" },
        { name: "name", label: "供应商名称", required: true },
        { name: "contact_name", label: "联系人" },
        { name: "phone", label: "联系电话" },
        // 地址（用户 2026-09-16：「供应商，需要多一个字段，地址」）
        { name: "address", label: "地址" },
        { name: "remark", label: "备注", type: "textarea" },
      ],
      submit: async (v) => {
        if (v.code_mode === "manual" && !v.supplier_code?.trim()) { setError("手动编码模式必须填写供应商编码"); return; }
        try {
          const result = await apiPost<Reference>("/suppliers", { ...v, code_mode: v.code_mode || "auto", supplier_code: v.supplier_code?.trim() || undefined, contact_name: v.contact_name || undefined, phone: v.phone || undefined, address: v.address || undefined, remark: v.remark || undefined });
          setSuppliers((items) => [...items.filter((i) => i.id !== result.data.id), result.data]);
          setCategoryDialog(null);
          notifySuccess(v.code_mode === "manual" ? "供应商已创建" : `供应商已创建（编码 ${result.data.supplierCode ?? "自动生成"}）`);
        } catch (cause) {
          notifyError(messageOf(cause, "供应商创建失败"));
        }
      },
    });
  }

  function editSupplier(item: Reference) {
    setDialog({
      title: `编辑供应商：${item.name ?? item.supplierCode ?? item.id}`,
      fields: [
        { name: "supplier_code", label: "供应商编码", required: true, defaultValue: item.supplierCode ?? item.code ?? "" },
        { name: "name", label: "供应商名称", required: true, defaultValue: item.name ?? "" },
        { name: "contact_name", label: "联系人", defaultValue: item.contactName ?? "" },
        { name: "phone", label: "联系电话", defaultValue: item.phone ?? "" },
        { name: "address", label: "地址", defaultValue: item.address ?? "" },
        { name: "remark", label: "备注", type: "textarea", defaultValue: item.remark ?? "" },
      ],
      submit: async (v) => {
        await action(`/suppliers/${item.id}`, { supplier_code: v.supplier_code, name: v.name, contact_name: v.contact_name || null, phone: v.phone || null, address: v.address || null, remark: v.remark || null }, "供应商已更新", "PATCH");
      },
    });
  }

  function deleteSupplier(id: string) {
    setDialog({
      title: "删除供应商",
      fields: [{ name: "confirm", label: "确认删除该供应商？（被采购单引用的供应商会被拒绝删除）", required: true, placeholder: "输入 删除 确认" }],
      submit: async (v) => {
        if (v.confirm?.trim() !== "删除") throw new Error("请输入\u201c删除\u201d确认");
        await apiRequest(`/suppliers/${id}`, { method: "DELETE" });
        notifySuccess("供应商已删除");
        await load();
      },
    });
  }

  const columns: ColumnDef<Reference>[] = [
    { accessorKey: "supplierCode", header: "供应商编码", meta: { width: COLUMN_WIDTH.supplierCode } },
    { accessorKey: "name", header: "供应商名称", meta: { width: COLUMN_WIDTH.name } },
    { accessorKey: "contactName", header: "联系人", meta: { width: COLUMN_WIDTH.contactName }, cell: ({ row }) => row.original.contactName ?? "-" },
    { accessorKey: "phone", header: "联系电话", meta: { width: COLUMN_WIDTH.phone }, cell: ({ row }) => row.original.phone ?? "-" },
    { accessorKey: "address", header: "地址", meta: { width: COLUMN_WIDTH.address }, cell: ({ row }) => row.original.address || "-" },
    { accessorKey: "remark", header: "备注", meta: { width: COLUMN_WIDTH.remark }, cell: ({ row }) => row.original.remark ?? "-" },
    { id: "status", header: "状态", meta: { width: COLUMN_WIDTH.status }, cell: ({ row }) => row.original.isActive === false ? "停用" : "启用" },
    ...auditColumns<Reference>(),
    {
      id: "actions", header: "操作", meta: { width: COLUMN_WIDTH.actions },
      cell: ({ row }) => (
        <div className="action-row purchase-table-actions">
          <Button size="sm" variant="secondary" onClick={() => editSupplier(row.original)}>编辑</Button>
          <Button size="sm" variant="ghost" onClick={() => void action(`/suppliers/${row.original.id}/active`, { is_active: row.original.isActive === false }, row.original.isActive === false ? "供应商已启用" : "供应商已停用")}>{row.original.isActive === false ? "启用" : "停用"}</Button>
          <Button size="sm" variant="destructive" onClick={() => deleteSupplier(row.original.id)}>删除</Button>
        </div>
      ),
    },
  ];

  if (loading) return <><PageHeader title="供应商池" breadcrumb={["采购", "供应商池"]} /><LoadingState /></>;
  if (categoryDialog) return <ActionDialog open title={categoryDialog.title} fields={categoryDialog.fields} onOpenChange={(open) => { if (!open) setCategoryDialog(null); }} onSubmit={(values) => { void categoryDialog.submit(values); }} />;

  return (
    <div className="page-root" data-testid="page-procurement-suppliers">
      <PageHeader title="供应商池" breadcrumb={["采购", "供应商池"]}>
        <div className="page-actions">
          <Button onClick={openSupplier}>新建供应商</Button>
          <Button variant="secondary" onClick={() => void load()}>刷新</Button>
        </div>
      </PageHeader>
      <ActionDialog open={Boolean(dialog)} onOpenChange={(open) => { if (!open) setDialog(null); }} title={dialog?.title ?? "操作"} fields={dialog?.fields ?? []} onSubmit={(values) => dialog?.submit(values)} />
      {message && <section className="panel panel-body status-success" role="status">{message}</section>}
      {error && <section className="panel"><ErrorState message={error} onRetry={() => void load()} /></section>}
      <section className="panel">
        <div className="panel-heading">
          <h2>供应商池</h2>
          <span className="panel-note" data-testid="supplier-count">共 {suppliers.length} 个供应商（启用 {suppliers.filter((item) => item.isActive !== false).length} 个 / 停用 {suppliers.filter((item) => item.isActive === false).length} 个），当前列出 {visible.length} 条</span>
        </div>
        <div className="panel-body">
          <div className="filter-bar">
            <label>搜索供应商编码、名称、联系人、电话或地址<Input data-testid="supplier-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="输入关键词，空格分隔多个词" /></label>
          </div>
          <DataTable
            columns={columns}
            data={visible}
            empty={query.trim()
              ? <EmptyState title={`没有匹配\u201c${query.trim()}\u201d的供应商`} description={`共 ${suppliers.length} 个供应商，换个关键词或清空搜索框。`} />
              : <EmptyState title="暂无供应商，点击\u201c新建供应商\u201d建立" />}
          />
        </div>
      </section>
    </div>
  );
}
