"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import type { ComponentProps, ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "../../lib/utils";

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export function DialogContent({ className, children, ...props }: ComponentProps<typeof DialogPrimitive.Content>) {
  return <DialogPrimitive.Portal><DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/30" /><DialogPrimitive.Content className={cn("fixed left-1/2 top-1/2 z-50 grid w-[min(520px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-5 shadow-lg", className)} {...props}>{children}<DialogPrimitive.Close className="absolute right-3 top-3 rounded-sm p-1 text-[var(--text-muted)] hover:bg-[var(--surface-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"><X size={16} /><span className="sr-only">关闭</span></DialogPrimitive.Close></DialogPrimitive.Content></DialogPrimitive.Portal>;
}
export function DialogHeader({ className, ...props }: ComponentProps<"div">) { return <div className={cn("flex flex-col gap-1.5", className)} {...props} />; }
export function DialogTitle({ className, ...props }: ComponentProps<typeof DialogPrimitive.Title>) { return <DialogPrimitive.Title className={cn("text-base font-semibold", className)} {...props} />; }
export function DialogDescription({ className, ...props }: ComponentProps<typeof DialogPrimitive.Description>) { return <DialogPrimitive.Description className={cn("text-sm text-[var(--text-muted)]", className)} {...props} />; }
export function DialogFooter({ className, ...props }: ComponentProps<"div">) { return <div className={cn("flex justify-end gap-2 pt-2", className)} {...props} />; }
export function DialogBody({ children }: { children: ReactNode }) { return <div className="grid gap-4">{children}</div>; }
