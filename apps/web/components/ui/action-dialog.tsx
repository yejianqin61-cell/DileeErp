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

export type ActionField = { name: string; label: string; type?: "text" | "date" | "time" | "number" | "textarea" | "select" | "searchable-select" | "multi-checkbox"; required?: boolean; defaultValue?: string; placeholder?: string; options?: Array<{ value: string; label: string }>; onSearch?: (query: string) => void; canAddCategory?: boolean; /** For multi-checkbox: options that render disabled (e.g. already attached). */ disabledValues?: string[] };
const categoryFields = new Set(["customer_id", "contact_id", "supplier_id", "material_id", "unit_id", "default_unit_id", "receipt_id", "department_id", "position_id", "employee_id", "employee_type", "execution_location_id", "operation_id"]);
export function ActionDialog({ open, title, fields, submitLabel = "保存", onOpenChange, onSubmit, onAddCategory }: { open: boolean; title: string; fields: ActionField[]; submitLabel?: string; onOpenChange: (open: boolean) => void; onSubmit: (values: Record<string, string>) => void | Promise<void>; onAddCategory?: (field: ActionField, values: Record<string, string>) => void | Promise<void> }) {
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
  function update(name: string, value: string) { setValues((current) => ({ ...current, [name]: value })); }
  async function submit() { const missing = fields.find((field) => field.required && !values[field.name]?.trim()); if (missing) { setValidationError(`${missing.type === "multi-checkbox" ? "请选择" : "请填写"}${missing.label}`); return; } setValidationError(""); setSubmitting(true); try { await onSubmit(values); onOpenChange(false); } catch (cause) { setValidationError(cause instanceof Error ? cause.message : "操作失败"); } finally { setSubmitting(false); } }
  async function addCategory(field: ActionField) { setSubmitting(true); try { await onAddCategory?.(field, { ...values }); } finally { setSubmitting(false); } }
  return <Dialog open={open} onOpenChange={(next) => { if (!submitting) onOpenChange(next); }}><DialogContent data-testid="action-dialog"><DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader><DialogBody>{fields.map((field) => <div className="ui-form-item" key={field.name} data-testid={field.type === "multi-checkbox" ? `action-field-${field.name}` : undefined}><div className="ui-form-label-row"><Label htmlFor={`action-${field.name}`}>{field.label}{field.required && <span className="ui-required"> *</span>}</Label></div>{field.type === "textarea" ? <Textarea id={`action-${field.name}`} data-testid={`action-field-${field.name}`} value={values[field.name] ?? ""} required={field.required} placeholder={field.placeholder} disabled={submitting} onChange={(event) => update(field.name, event.target.value)} /> : field.type === "multi-checkbox" ? <MultiCheckboxSelect id={`action-${field.name}`} options={field.options ?? []} selected={(values[field.name] ?? "").split(",").filter(Boolean)} disabledValues={field.disabledValues} disabled={submitting} label={field.label} searchPlaceholder={field.placeholder} onChange={(selected) => update(field.name, selected.join(","))} /> : field.type === "select" || field.type === "searchable-select" ? <div className="ui-select-with-action" data-testid={field.type === "searchable-select" ? `action-field-${field.name}` : undefined}>{field.type === "searchable-select" ? <SearchableSelect id={`action-${field.name}`} value={values[field.name] ?? ""} options={field.options ?? []} placeholder={field.placeholder ?? "请选择"} label={field.label} disabled={submitting} onSearch={field.onSearch} onChange={(value) => update(field.name, value)} /> : <Select value={values[field.name] ?? ""} onValueChange={(value) => update(field.name, value)} disabled={submitting}><SelectTrigger id={`action-${field.name}`} data-testid={`action-field-${field.name}`}><SelectValue placeholder={field.placeholder ?? "请选择"} /></SelectTrigger><SelectContent>{field.options?.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent></Select>}{(field.canAddCategory ?? categoryFields.has(field.name)) && <Button type="button" variant="secondary" size="sm" className="ui-select-add-button" disabled={submitting} onClick={() => addCategory(field)}>新增类目</Button>}</div> : <Input id={`action-${field.name}`} data-testid={`action-field-${field.name}`} type={field.type ?? "text"} value={values[field.name] ?? ""} required={field.required} placeholder={field.placeholder} disabled={submitting} onChange={(event) => update(field.name, event.target.value)} />}</div>)}{validationError && <p className="ui-form-message" role="alert" data-testid="action-dialog-error">{validationError}</p>}</DialogBody><DialogFooter><Button type="button" variant="secondary" disabled={submitting} onClick={() => onOpenChange(false)} data-testid="action-dialog-cancel">取消</Button><Button type="button" disabled={submitting} onClick={() => void submit()} data-testid="action-dialog-submit">{submitting ? "提交中…" : submitLabel}</Button></DialogFooter></DialogContent></Dialog>;
}
