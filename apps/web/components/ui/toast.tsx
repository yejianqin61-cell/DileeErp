"use client";

import * as ToastPrimitive from "@radix-ui/react-toast";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../lib/utils";

export const ToastProvider = ToastPrimitive.Provider;
export const ToastViewport = ({ className, ...props }: ComponentProps<typeof ToastPrimitive.Viewport>) => <ToastPrimitive.Viewport className={cn("ui-toast-viewport", className)} {...props} />;
export const Toast = ({ className, ...props }: ComponentProps<typeof ToastPrimitive.Root>) => <ToastPrimitive.Root className={cn("ui-toast", className)} {...props} />;
export const ToastTitle = ({ className, ...props }: ComponentProps<typeof ToastPrimitive.Title>) => <ToastPrimitive.Title className={cn("ui-toast-title", className)} {...props} />;
export const ToastDescription = ({ className, ...props }: ComponentProps<typeof ToastPrimitive.Description>) => <ToastPrimitive.Description className={cn("ui-toast-description", className)} {...props} />;
export const ToastClose = ToastPrimitive.Close;
export function ToastAction({ children, className, ...props }: ComponentProps<typeof ToastPrimitive.Action> & { children: ReactNode }) { return <ToastPrimitive.Action className={cn("ui-toast-action", className)} {...props}>{children}</ToastPrimitive.Action>; }
