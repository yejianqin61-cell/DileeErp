"use client";

import * as SelectPrimitive from "@radix-ui/react-select";
import type { ComponentProps } from "react";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "../../lib/utils";

export const Select = SelectPrimitive.Root;
export const SelectGroup = SelectPrimitive.Group;
export const SelectValue = SelectPrimitive.Value;
export const SelectTrigger = ({ className, children, ...props }: ComponentProps<typeof SelectPrimitive.Trigger>) => <SelectPrimitive.Trigger className={cn("flex h-9 w-full items-center justify-between rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 text-sm outline-none focus:ring-2 focus:ring-[var(--focus-ring)]", className)} {...props}>{children}<ChevronDown size={15} /></SelectPrimitive.Trigger>;
export const SelectContent = ({ className, ...props }: ComponentProps<typeof SelectPrimitive.Content>) => <SelectPrimitive.Portal><SelectPrimitive.Content className={cn("z-50 min-w-32 overflow-hidden rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-1 shadow-lg", className)} position="popper" {...props} /></SelectPrimitive.Portal>;
export const SelectLabel = ({ className, ...props }: ComponentProps<typeof SelectPrimitive.Label>) => <SelectPrimitive.Label className={cn("px-2 py-1.5 text-xs font-semibold text-[var(--text-muted)]", className)} {...props} />;
export const SelectItem = ({ className, children, ...props }: ComponentProps<typeof SelectPrimitive.Item>) => <SelectPrimitive.Item className={cn("relative flex cursor-default select-none items-center rounded-sm py-1.5 pl-8 pr-2 text-sm outline-none focus:bg-[var(--surface-muted)] data-[disabled]:pointer-events-none data-[disabled]:opacity-50", className)} {...props}><span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center"><SelectPrimitive.ItemIndicator><Check size={14} /></SelectPrimitive.ItemIndicator></span><SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText></SelectPrimitive.Item>;
