"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "./button";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "./dialog";
import { Input } from "./input";
import { Label } from "./label";
import { MultiCheckboxSelect } from "./multi-checkbox-select";
import { SearchableSelect } from "./searchable-select";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./select";
import { Textarea } from "./textarea";

export type ActionField = { name: string; label: string; type?: "text" | "date" | "time" | "number" | "textarea" | "select" | "searchable-select" | "multi-checkbox" | "info"; required?: boolean; defaultValue?: string; placeholder?: string; options?: Array<{ value: string; label: string }>; onSearch?: (query: string) => void; canAddCategory?: boolean; /** For multi-checkbox: options that render disabled (e.g. already attached). */ disabledValues?: string[] };
/**
 * 表单里的下拉该不该带搜索框（2026-11-13，用户：「所有下拉列表、所有表单……都要有搜索功能，
 * 因为现在单子多了，查找比较麻烦」）。
 *
 * 谁需要搜索：**选项来自数据、而且会长长**的那些 —— 客户、供应商、物料、生产单、银行账户、
 * 会计科目、员工、部门/岗位、单位、工序。谁不需要：性别、是否、借贷方向、币种这种 2–8 项的固定枚举
 * （给两个选项配一个搜索框，只是让表单变啰嗦）。
 *
 * 两条判据：
 *   1. 字段显式声明 `type: "searchable-select"` → 一定有搜索（调用方最清楚这份清单会不会长）；
 *   2. `type: "select"` 但选项**多于 8 项** → 自动升级成带搜索的下拉。
 *      8 的依据是弹层高度：288px 的弹层正好放得下 8 行，再多就要滚 —— 要滚的清单就该能搜。
 *
 * 为什么做成自动升级而不是把 67 个 `type: "select"` 逐个改成 `searchable-select`：
 * 那些字段的选项是**运行时**才知道长度的（`customers.map(...)`），静态改写要么漏、要么在新客户/新物料
 * 进来之后悄悄退回没有搜索。放在这里，规则只有一份，任何表单字段都自动受益。
 */
export const SEARCHABLE_FIELD_MIN_OPTIONS = 9;
export function usesSearchableField(field: ActionField): boolean {
  if (field.type === "searchable-select") return true;
  if (field.type !== "select") return false;
  return (field.options?.length ?? 0) >= SEARCHABLE_FIELD_MIN_OPTIONS;
}
const categoryFields = new Set(["customer_id", "contact_id", "supplier_id", "material_id", "unit_id", "default_unit_id", "receipt_id", "department_id", "position_id", "employee_id", "employee_type", "execution_location_id", "operation_id"]);
export function ActionDialog({ open, title, fields, submitLabel = "保存", onOpenChange, onSubmit, onAddCategory, deriveValues }: { open: boolean; title: string; fields: ActionField[]; submitLabel?: string; onOpenChange: (open: boolean) => void; onSubmit: (values: Record<string, string>) => void | Promise<void>; onAddCategory?: (field: ActionField, values: Record<string, string>) => void | Promise<void>; /**
   * 字段联动（表单内自动填充）：每次字段变更后调用，收到的补丁合并进表单。
   * changedField 是刚刚被编辑的字段名 —— 调用方据此判断「该不该触发联动」，
   * 例如只在 id_card_no 变化时重新解析出生日期/性别/住址。
   * 必须是纯函数（React 可能重复调用它）。
   */ deriveValues?: (changedField: string, values: Record<string, string>) => Record<string, string> }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [validationError, setValidationError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (!open) { wasOpen.current = false; return; }
    setValues((current) => Object.fromEntries(fields.map((field) => [field.name, wasOpen.current ? (current[field.name] || field.defaultValue || "") : field.defaultValue ?? ""])));
    setValidationError("");
    setSubmitting(false);
    wasOpen.current = true;
  }, [open, fields]);
  function update(name: string, value: string) { setValues((current) => { const next = { ...current, [name]: value }; const patch = deriveValues?.(name, next); return patch && Object.keys(patch).length ? { ...next, ...patch } : next; }); }
  async function submit() { const missing = fields.find((field) => field.required && !values[field.name]?.trim()); if (missing) { setValidationError(`${missing.type === "multi-checkbox" ? "请选择" : "请填写"}${missing.label}`); return; } setValidationError(""); setSubmitting(true); try { await onSubmit(values); onOpenChange(false); } catch (cause) { setValidationError(cause instanceof Error ? cause.message : "操作失败"); } finally { setSubmitting(false); } }
  async function addCategory(field: ActionField) { setSubmitting(true); try { await onAddCategory?.(field, { ...values }); } finally { setSubmitting(false); } }
  return <Dialog open={open} onOpenChange={(next) => { if (!submitting) onOpenChange(next); }}><DialogContent data-testid="action-dialog"><DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader><DialogBody>{fields.map((field) => <div className="ui-form-item" key={field.name} data-testid={field.type === "multi-checkbox" ? `action-field-${field.name}` : undefined}>{field.type === "info" ? <p className="panel-note ui-form-info">{field.label}</p> : <><div className="ui-form-label-row"><Label htmlFor={`action-${field.name}`}>{field.label}{field.required && <span className="ui-required"> *</span>}</Label></div>{field.type === "textarea" ? <Textarea id={`action-${field.name}`} data-testid={`action-field-${field.name}`} value={values[field.name] ?? ""} required={field.required} placeholder={field.placeholder} disabled={submitting} onChange={(event) => update(field.name, event.target.value)} /> : field.type === "multi-checkbox" ? <MultiCheckboxSelect id={`action-${field.name}`} options={field.options ?? []} selected={(values[field.name] ?? "").split(",").filter(Boolean)} disabledValues={field.disabledValues} disabled={submitting} label={field.label} searchPlaceholder={field.placeholder} onChange={(selected) => update(field.name, selected.join(","))} /> : field.type === "select" || field.type === "searchable-select" ? <div className="ui-select-with-action" data-testid={usesSearchableField(field) ? `action-field-${field.name}` : undefined}>{usesSearchableField(field) ? <SearchableSelect id={`action-${field.name}`} value={values[field.name] ?? ""} options={field.options ?? []} placeholder={field.placeholder ?? "请选择"} label={field.label} disabled={submitting} onSearch={field.onSearch} onChange={(value) => update(field.name, value)} /> : <Select value={values[field.name] ?? ""} onValueChange={(value) => update(field.name, value)} disabled={submitting}><SelectTrigger id={`action-${field.name}`} data-testid={`action-field-${field.name}`}><SelectValue placeholder={field.placeholder ?? "请选择"} /></SelectTrigger><SelectContent>{field.options?.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent></Select>}{(field.canAddCategory ?? categoryFields.has(field.name)) && <Button type="button" variant="secondary" size="sm" className="ui-select-add-button" disabled={submitting} onClick={() => addCategory(field)}>新增类目</Button>}</div> : <Input id={`action-${field.name}`} data-testid={`action-field-${field.name}`} type={field.type ?? "text"} value={values[field.name] ?? ""} required={field.required} placeholder={field.placeholder} disabled={submitting} onChange={(event) => update(field.name, event.target.value)} />}</>}</div>)}{validationError && <p className="ui-form-message" role="alert" data-testid="action-dialog-error">{validationError}</p>}</DialogBody><DialogFooter><Button type="button" variant="secondary" disabled={submitting} onClick={() => onOpenChange(false)} data-testid="action-dialog-cancel">取消</Button><Button type="button" disabled={submitting} onClick={() => void submit()} data-testid="action-dialog-submit">{submitting ? "提交中…" : submitLabel}</Button></DialogFooter></DialogContent></Dialog>;
}