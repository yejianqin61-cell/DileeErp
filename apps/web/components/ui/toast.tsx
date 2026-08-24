"use client";

import * as ToastPrimitive from "@radix-ui/react-toast";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../lib/utils";

export const ToastProvider = ToastPrimitive.Provider;
export const ToastViewport = ({ className, ...props }: ComponentProps<typeof ToastPrimitive.Viewport>) => <ToastPrimitive.Viewport className={cn("fixed right-4 top-4 z-[100] grid w-[min(360px,calc(100vw-32px))] gap-2 outline-none", className)} {...props} />;
export const Toast = ({ className, ...props }: ComponentProps<typeof ToastPrimitive.Root>) => <ToastPrimitive.Root className={cn("group relative grid gap-1 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4 pr-10 text-sm shadow-lg", className)} {...props} />;
export const ToastTitle = ({ className, ...props }: ComponentProps<typeof ToastPrimitive.Title>) => <ToastPrimitive.Title className={cn("font-semibold", className)} {...props} />;
export const ToastDescription = ({ className, ...props }: ComponentProps<typeof ToastPrimitive.Description>) => <ToastPrimitive.Description className={cn("text-[var(--text-muted)]", className)} {...props} />;
export const ToastClose = ToastPrimitive.Close;
export function ToastAction({ children, ...props }: ComponentProps<typeof ToastPrimitive.Action> & { children: ReactNode }) { return <ToastPrimitive.Action className="absolute right-3 top-3 text-xs text-[var(--primary)]" {...props}>{children}</ToastPrimitive.Action>; }
