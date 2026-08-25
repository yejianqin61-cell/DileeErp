"use client";

import * as SelectPrimitive from "@radix-ui/react-select";
import type { ComponentProps } from "react";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "../../lib/utils";

export const Select = SelectPrimitive.Root;
export const SelectGroup = SelectPrimitive.Group;
export const SelectValue = SelectPrimitive.Value;
export const SelectTrigger = ({ className, children, ...props }: ComponentProps<typeof SelectPrimitive.Trigger>) => <SelectPrimitive.Trigger className={cn("ui-select-trigger", className)} {...props}>{children}<ChevronDown size={15} /></SelectPrimitive.Trigger>;
export const SelectContent = ({ className, ...props }: ComponentProps<typeof SelectPrimitive.Content>) => <SelectPrimitive.Portal><SelectPrimitive.Content className={cn("ui-select-content", className)} position="popper" {...props} /></SelectPrimitive.Portal>;
export const SelectLabel = ({ className, ...props }: ComponentProps<typeof SelectPrimitive.Label>) => <SelectPrimitive.Label className={cn("ui-select-label", className)} {...props} />;
export const SelectItem = ({ className, children, ...props }: ComponentProps<typeof SelectPrimitive.Item>) => <SelectPrimitive.Item className={cn("ui-select-item", className)} {...props}><span className="ui-select-item-indicator"><SelectPrimitive.ItemIndicator><Check size={14} /></SelectPrimitive.ItemIndicator></span><SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText></SelectPrimitive.Item>;
