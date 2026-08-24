"use client";

import * as AlertDialogPrimitive from "@radix-ui/react-alert-dialog";
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

export const AlertDialog = AlertDialogPrimitive.Root;
export const AlertDialogTrigger = AlertDialogPrimitive.Trigger;
export const AlertDialogCancel = AlertDialogPrimitive.Cancel;
export const AlertDialogAction = AlertDialogPrimitive.Action;
export function AlertDialogContent({ className, ...props }: ComponentProps<typeof AlertDialogPrimitive.Content>) {
  return <AlertDialogPrimitive.Portal><AlertDialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/30" /><AlertDialogPrimitive.Content className={cn("fixed left-1/2 top-1/2 z-50 grid w-[min(440px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-5 shadow-lg", className)} {...props} />;</AlertDialogPrimitive.Portal>;
}
export function AlertDialogHeader({ className, ...props }: ComponentProps<"div">) { return <div className={cn("grid gap-1.5", className)} {...props} />; }
export function AlertDialogTitle({ className, ...props }: ComponentProps<typeof AlertDialogPrimitive.Title>) { return <AlertDialogPrimitive.Title className={cn("text-base font-semibold", className)} {...props} />; }
export function AlertDialogDescription({ className, ...props }: ComponentProps<typeof AlertDialogPrimitive.Description>) { return <AlertDialogPrimitive.Description className={cn("text-sm text-[var(--text-muted)]", className)} {...props} />; }
export function AlertDialogFooter({ className, ...props }: ComponentProps<"div">) { return <div className={cn("flex justify-end gap-2 pt-2", className)} {...props} />; }
