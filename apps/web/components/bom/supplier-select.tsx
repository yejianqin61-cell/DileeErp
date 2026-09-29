"use client";

// BOM 行上的「默认供应商」选择器（2026-09-26）。
//
// 用户原话：「针对 BOM 表，要新增一个 column，供应商。同时允许在下拉列表中快速新建。」
//
// 「在下拉列表中快速新建」的做法：搜不到就把**这一项**变成「＋ 新建供应商「xxx」」，
// 选它即用刚输入的词当名称开新建弹窗 —— 少一次跳转，也不用先记住名字再回来搜。
// 为什么不用「工具栏按钮」那种做法（与「新建物料」并列）：那句原话明确说了"在下拉列表中"，
// 而且这里的新建是**有上下文**的（用户已经在打名字了）。
//
// 复用 `SearchableSelect` 而不是自己写一个：它的搜索/键盘/弹层定位都是现成的，
// 唯一需要的是"多给一个选项"，而它的 `onSearch` 本来就允许选项在打开期间变化。
import { useMemo, useState } from "react";
import { ActionDialog } from "../ui/action-dialog";
import { SearchableSelect } from "../ui/searchable-select";
import { ApiClientError, apiPost } from "../../lib/api-client";
import { notifyError, notifySuccess } from "../ui/toaster";

export type BomSupplierRef = {
  id: string;
  supplierCode?: string | null;
  code?: string | null;
  name?: string | null;
  contactName?: string | null;
  phone?: string | null;
  isActive?: boolean;
};

/** 合成选项的哨兵值：真实供应商 id 都是 UUID，不会撞上它。 */
const CREATE_VALUE = "__create_supplier__";

const labelOf = (supplier: BomSupplierRef) => `${supplier.supplierCode ?? supplier.code ?? ""}${supplier.supplierCode || supplier.code ? " / " : ""}${supplier.name ?? "供应商"}`;
const messageOf = (cause: unknown, fallback: string) => (cause instanceof ApiClientError ? cause.message : fallback);

export function SupplierSelect({ value, suppliers, onChange, onCreated, disabled, testId = "bom-supplier-select" }: {
  value: string;
  suppliers: BomSupplierRef[];
  /** 选中一个已有供应商（或刚建好的那个）。 */
  onChange: (supplierId: string) => void;
  /** 新建成功：调用方把它并进自己的供应商池，后续下拉才有它。 */
  onCreated?: (supplier: BomSupplierRef) => void;
  disabled?: boolean;
  testId?: string;
}) {
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);

  const options = useMemo(() => {
    const active = suppliers.filter((supplier) => supplier.isActive !== false).map((supplier) => ({ value: supplier.id, label: labelOf(supplier) }));
    const typed = query.trim();
    // 已经有一家叫这个名字了就不再提"新建"：否则用户建完会撞 `suppliers.name` 的唯一约束，
    // 而正确的动作本来就是"选那一家"。
    const exists = typed !== "" && suppliers.some((supplier) => (supplier.name ?? "").trim().toLowerCase() === typed.toLowerCase());
    return typed && !exists ? [...active, { value: CREATE_VALUE, label: `＋ 新建供应商「${typed}」` }] : active;
  }, [suppliers, query]);

  return (
    <>
      <SearchableSelect
        value={value}
        options={options}
        onChange={(next) => {
          if (next === CREATE_VALUE) { setCreating(true); return; }
          onChange(next);
        }}
        onSearch={setQuery}
        disabled={disabled}
        placeholder="选择供应商"
        label="供应商"
        searchPlaceholder="搜供应商名称，或直接输入新供应商名"
        noResultsText="没有匹配的供应商：把名字打完整就能新建"
        testId={testId}
      />
      {creating ? (
        <ActionDialog
          open
          title={`新建供应商${query.trim() ? `：${query.trim()}` : ""}`}
          submitLabel="保存并选用"
          fields={[
            { name: "name", label: "供应商名称", required: true, defaultValue: query.trim(), placeholder: "例：宁波辅料厂" },
            { name: "code_mode", label: "编码方式", type: "select", required: true, defaultValue: "auto", options: [{ value: "auto", label: "自动生成" }, { value: "manual", label: "手动填写" }] },
            { name: "supplier_code", label: "供应商编码", placeholder: "自动生成时留空" },
            { name: "contact_name", label: "联系人" },
            { name: "phone", label: "电话" },
          ]}
          onOpenChange={(open) => { if (!open) setCreating(false); }}
          onSubmit={async (values) => {
            try {
              // 走既有供应商池的接口（编码方式 auto/manual 与物料/供应商页同一套约定）。
              const result = await apiPost<BomSupplierRef>("/suppliers", {
                name: values.name,
                code_mode: values.code_mode || "auto",
                supplier_code: values.supplier_code || undefined,
                contact_name: values.contact_name || undefined,
                phone: values.phone || undefined,
              });
              notifySuccess(`供应商已创建：${result.data.supplierCode ?? result.data.code ?? result.data.name ?? ""}`);
              onCreated?.(result.data);
              onChange(result.data.id);
              setQuery("");
              setCreating(false);
            } catch (cause) {
              notifyError(messageOf(cause, "供应商创建失败"));
              // 抛出去：ActionDialog 保持弹窗打开并显示原因，用户不用重新填
              throw cause;
            }
          }}
        />
      ) : null}
    </>
  );
}
