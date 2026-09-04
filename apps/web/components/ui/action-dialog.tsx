"use client";

import { useEffect, useState } from "react";
import { Button } from "./button";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "./dialog";
import { Input } from "./input";
import { Label } from "./label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./select";
import { Textarea } from "./textarea";

export type ActionField = { name: string; label: string; type?: "text" | "date" | "time" | "number" | "textarea" | "select"; required?: boolean; defaultValue?: string; placeholder?: string; options?: Array<{ value: string; label: string }>; canAddCategory?: boolean };
const categoryFields = new Set(["customer_id", "contact_id", "supplier_id", "material_id", "unit_id", "default_unit_id", "receipt_id", "department_id", "position_id", "employee_type", "execution_location_id", "operation_id"]);
export function ActionDialog({ open, title, fields, submitLabel = "保存", onOpenChange, onSubmit, onAddCategory }: { open: boolean; title: string; fields: ActionField[]; submitLabel?: string; onOpenChange: (open: boolean) => void; onSubmit: (values: Record<string, string>) => void | Promise<void>; onAddCategory?: (field: ActionField, values: Record<string, string>) => void | Promise<void> }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [validationError, setValidationError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  useEffect(() => { if (open) { setValues(Object.fromEntries(fields.map((field) => [field.name, field.defaultValue ?? ""]))); setValidationError(""); setSubmitting(false); } }, [open, fields]);
  function update(name: string, value: string) { setValues((current) => ({ ...current, [name]: value })); }
  async function submit() { const missing = fields.find((field) => field.required && !values[field.name]?.trim()); if (missing) { setValidationError(`请填写${missing.label}`); return; } setValidationError(""); setSubmitting(true); try { await onSubmit(values); onOpenChange(false); } finally { setSubmitting(false); } }
  async function addCategory(field: ActionField) { setSubmitting(true); try { await onAddCategory?.(field, { ...values }); } finally { setSubmitting(false); } }
  return <Dialog open={open} onOpenChange={(next) => { if (!submitting) onOpenChange(next); }}><DialogContent><DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader><DialogBody>{fields.map((field) => <div className="ui-form-item" key={field.name}><div className="ui-form-label-row"><Label htmlFor={`action-${field.name}`}>{field.label}{field.required && <span className="ui-required"> *</span>}</Label></div>{field.type === "textarea" ? <Textarea id={`action-${field.name}`} value={values[field.name] ?? ""} required={field.required} placeholder={field.placeholder} disabled={submitting} onChange={(event) => update(field.name, event.target.value)} /> : field.type === "select" ? <div className="ui-select-with-action"><Select value={values[field.name] ?? ""} onValueChange={(value) => update(field.name, value)} disabled={submitting}><SelectTrigger id={`action-${field.name}`}><SelectValue placeholder={field.placeholder ?? "请选择"} /></SelectTrigger><SelectContent>{field.options?.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent></Select>{(field.canAddCategory ?? categoryFields.has(field.name)) && <Button type="button" variant="secondary" size="sm" className="ui-select-add-button" disabled={submitting} onClick={() => addCategory(field)}>新增类目</Button>}</div> : <Input id={`action-${field.name}`} type={field.type ?? "text"} value={values[field.name] ?? ""} required={field.required} placeholder={field.placeholder} disabled={submitting} onChange={(event) => update(field.name, event.target.value)} />}</div>)}{validationError && <p className="ui-form-message" role="alert">{validationError}</p>}</DialogBody><DialogFooter><Button type="button" variant="secondary" disabled={submitting} onClick={() => onOpenChange(false)}>取消</Button><Button type="button" disabled={submitting} onClick={() => void submit()}>{submitting ? "提交中…" : submitLabel}</Button></DialogFooter></DialogContent></Dialog>;
}
