"use client";

import * as AlertDialogPrimitive from "@radix-ui/react-alert-dialog";
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

export const AlertDialog = AlertDialogPrimitive.Root;
export const AlertDialogTrigger = AlertDialogPrimitive.Trigger;
export const AlertDialogCancel = AlertDialogPrimitive.Cancel;
export const AlertDialogAction = AlertDialogPrimitive.Action;
export function AlertDialogContent({ className, ...props }: ComponentProps<typeof AlertDialogPrimitive.Content>) {
  return <AlertDialogPrimitive.Portal><AlertDialogPrimitive.Overlay className="ui-dialog-overlay" /><AlertDialogPrimitive.Content className={cn("ui-alert-dialog-content", className)} {...props} />;</AlertDialogPrimitive.Portal>;
}
export function AlertDialogHeader({ className, ...props }: ComponentProps<"div">) { return <div className={cn("ui-dialog-header", className)} {...props} />; }
export function AlertDialogTitle({ className, ...props }: ComponentProps<typeof AlertDialogPrimitive.Title>) { return <AlertDialogPrimitive.Title className={cn("ui-dialog-title", className)} {...props} />; }
export function AlertDialogDescription({ className, ...props }: ComponentProps<typeof AlertDialogPrimitive.Description>) { return <AlertDialogPrimitive.Description className={cn("ui-dialog-description", className)} {...props} />; }
export function AlertDialogFooter({ className, ...props }: ComponentProps<"div">) { return <div className={cn("ui-dialog-footer", className)} {...props} />; }
