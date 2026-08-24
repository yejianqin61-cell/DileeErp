"use client";

import { useEffect, useState } from "react";
import { Button } from "./button";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "./dialog";
import { Input } from "./input";
import { Label } from "./label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./select";
import { Textarea } from "./textarea";

export type ActionField = { name: string; label: string; type?: "text" | "date" | "number" | "textarea" | "select"; required?: boolean; defaultValue?: string; placeholder?: string; options?: Array<{ value: string; label: string }> };
export function ActionDialog({ open, title, fields, submitLabel = "保存", onOpenChange, onSubmit }: { open: boolean; title: string; fields: ActionField[]; submitLabel?: string; onOpenChange: (open: boolean) => void; onSubmit: (values: Record<string, string>) => void }) {
  const [values, setValues] = useState<Record<string, string>>({});
  useEffect(() => { if (open) setValues(Object.fromEntries(fields.map((field) => [field.name, field.defaultValue ?? ""]))); }, [open, fields]);
  function update(name: string, value: string) { setValues((current) => ({ ...current, [name]: value })); }
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent><DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader><DialogBody>{fields.map((field) => <div className="grid gap-1.5" key={field.name}><Label htmlFor={`action-${field.name}`}>{field.label}{field.required && <span className="text-[var(--danger)]"> *</span>}</Label>{field.type === "textarea" ? <Textarea id={`action-${field.name}`} value={values[field.name] ?? ""} required={field.required} placeholder={field.placeholder} onChange={(event) => update(field.name, event.target.value)} /> : field.type === "select" ? <Select value={values[field.name] ?? ""} onValueChange={(value) => update(field.name, value)}><SelectTrigger id={`action-${field.name}`}><SelectValue placeholder={field.placeholder ?? "请选择"} /></SelectTrigger><SelectContent>{field.options?.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent></Select> : <Input id={`action-${field.name}`} type={field.type ?? "text"} value={values[field.name] ?? ""} required={field.required} placeholder={field.placeholder} onChange={(event) => update(field.name, event.target.value)} />}</div>)}</DialogBody><DialogFooter><Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>取消</Button><Button type="button" onClick={() => { onSubmit(values); onOpenChange(false); }}>{submitLabel}</Button></DialogFooter></DialogContent></Dialog>;
}
