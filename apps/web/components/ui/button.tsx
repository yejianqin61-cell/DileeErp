import { cva, type VariantProps } from "class-variance-authority";
import type { ButtonHTMLAttributes } from "react";
import { cn } from "../../lib/utils";

const buttonVariants = cva("inline-flex h-9 items-center justify-center gap-2 rounded-[var(--radius)] px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)] disabled:pointer-events-none disabled:opacity-50", {
  variants: { variant: { default: "bg-[var(--primary)] text-[var(--primary-foreground)] hover:brightness-95", secondary: "border border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--surface-muted)]", ghost: "hover:bg-[var(--surface-muted)]" } },
  defaultVariants: { variant: "default" },
});

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {}
export function Button({ className, variant, ...props }: ButtonProps) { return <button className={cn(buttonVariants({ variant }), className)} {...props} />; }
