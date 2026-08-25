"use client";

import type { ComponentProps, ReactNode } from "react";
import { Controller, FormProvider, type ControllerProps, type FieldPath, type FieldValues, type UseFormReturn } from "react-hook-form";
import { Label } from "./label";
import { cn } from "../../lib/utils";

export function Form<TFieldValues extends FieldValues>({ form, children }: { form: UseFormReturn<TFieldValues>; children: ReactNode }) { return <FormProvider {...form}>{children}</FormProvider>; }
export function FormField<TFieldValues extends FieldValues, TName extends FieldPath<TFieldValues>>(props: ControllerProps<TFieldValues, TName>) { return <Controller {...props} />; }
export function FormItem({ className, ...props }: ComponentProps<"div">) { return <div className={cn("ui-form-item", className)} {...props} />; }
export function FormLabel({ className, ...props }: ComponentProps<typeof Label>) { return <Label className={cn("ui-form-label", className)} {...props} />; }
export function FormControl({ children }: { children: ReactNode }) { return <>{children}</>; }
export function FormDescription({ className, ...props }: ComponentProps<"p">) { return <p className={cn("ui-form-description", className)} {...props} />; }
export function FormMessage({ className, children, ...props }: ComponentProps<"p"> & { children?: ReactNode }) { return <p className={cn("ui-form-message", className)} {...props}>{children}</p>; }
