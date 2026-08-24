"use client";

import type { ComponentProps, ReactNode } from "react";
import { Controller, FormProvider, useFormContext, type ControllerProps, type FieldPath, type FieldValues, type UseFormReturn } from "react-hook-form";
import { Label } from "./label";
import { cn } from "../../lib/utils";

export function Form<TFieldValues extends FieldValues>({ form, children }: { form: UseFormReturn<TFieldValues>; children: ReactNode }) { return <FormProvider {...form}>{children}</FormProvider>; }
export function FormField<TFieldValues extends FieldValues, TName extends FieldPath<TFieldValues>>(props: ControllerProps<TFieldValues, TName>) { return <Controller {...props} />; }
export function FormItem({ className, ...props }: ComponentProps<"div">) { return <div className={cn("grid gap-1.5", className)} {...props} />; }
export function FormLabel({ className, ...props }: ComponentProps<typeof Label>) { return <Label className={cn("text-sm", className)} {...props} />; }
export function FormControl({ children }: { children: ReactNode }) { return <>{children}</>; }
export function FormDescription({ className, ...props }: ComponentProps<"p">) { return <p className={cn("text-xs text-[var(--text-muted)]", className)} {...props} />; }
export function FormMessage({ className, children, ...props }: ComponentProps<"p">) { const { formState } = useFormContext(); return <p className={cn("min-h-4 text-xs text-[var(--danger)]", className)} {...props}>{children ?? (typeof formState.errors === "object" ? "" : "")}</p>; }
