"use client";

import * as SheetPrimitive from "@radix-ui/react-dialog";
import type { ComponentProps } from "react";
import { X } from "lucide-react";
import { cn } from "../../lib/utils";

export const Sheet = SheetPrimitive.Root;
export const SheetTrigger = SheetPrimitive.Trigger;
export const SheetClose = SheetPrimitive.Close;

export function SheetContent({ side = "right", className, children, onClose, ...props }: ComponentProps<typeof SheetPrimitive.Content> & { side?: "top" | "right" | "bottom" | "left"; onClose?: () => void }) {
  const sideClass = { top: "ui-sheet-top", right: "ui-sheet-right", bottom: "ui-sheet-bottom", left: "ui-sheet-left" }[side];
  return <SheetPrimitive.Portal><SheetPrimitive.Overlay className="ui-dialog-overlay" /><SheetPrimitive.Content className={cn("ui-sheet-content", sideClass, className)} {...props}>{children}<SheetPrimitive.Close className="ui-dialog-close" type="button" onClick={onClose}><X size={16} /><span>关闭</span></SheetPrimitive.Close></SheetPrimitive.Content></SheetPrimitive.Portal>;
}
export function SheetHeader({ className, ...props }: ComponentProps<"div">) { return <div className={cn("ui-dialog-header", className)} {...props} />; }
export function SheetTitle({ className, ...props }: ComponentProps<typeof SheetPrimitive.Title>) { return <SheetPrimitive.Title className={cn("ui-dialog-title", className)} {...props} />; }
export function SheetDescription({ className, ...props }: ComponentProps<typeof SheetPrimitive.Description>) { return <SheetPrimitive.Description className={cn("ui-dialog-description", className)} {...props} />; }
