"use client";

import * as SheetPrimitive from "@radix-ui/react-dialog";
import type { ComponentProps } from "react";
import { X } from "lucide-react";
import { cn } from "../../lib/utils";

export const Sheet = SheetPrimitive.Root;
export const SheetTrigger = SheetPrimitive.Trigger;
export const SheetClose = SheetPrimitive.Close;
export function SheetContent({ side = "right", className, children, ...props }: ComponentProps<typeof SheetPrimitive.Content> & { side?: "top" | "right" | "bottom" | "left" }) {
  const sideClass = { top: "ui-sheet-top", right: "ui-sheet-right", bottom: "ui-sheet-bottom", left: "ui-sheet-left" }[side];
  return <SheetPrimitive.Portal><SheetPrimitive.Overlay className="fixed inset-0 z-40 bg-black/30" /><SheetPrimitive.Content className={cn("fixed z-50 grid gap-4 border-[var(--border)] bg-[var(--surface)] p-5 shadow-lg", sideClass, className)} {...props}>{children}<SheetPrimitive.Close className="absolute right-3 top-3 rounded-sm p-1 text-[var(--text-muted)] hover:bg-[var(--surface-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"><X size={16} /><span className="sr-only">关闭</span></SheetPrimitive.Close></SheetPrimitive.Content></SheetPrimitive.Portal>;
}
export function SheetHeader({ className, ...props }: ComponentProps<"div">) { return <div className={cn("grid gap-1.5", className)} {...props} />; }
export function SheetTitle({ className, ...props }: ComponentProps<typeof SheetPrimitive.Title>) { return <SheetPrimitive.Title className={cn("text-base font-semibold", className)} {...props} />; }
export function SheetDescription({ className, ...props }: ComponentProps<typeof SheetPrimitive.Description>) { return <SheetPrimitive.Description className={cn("text-sm text-[var(--text-muted)]", className)} {...props} />; }
