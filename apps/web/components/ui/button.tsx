import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "@radix-ui/react-slot";
import type { ButtonHTMLAttributes } from "react";
import { cn } from "../../lib/utils";

const buttonVariants = cva("inline-flex h-9 items-center justify-center gap-2 whitespace-nowrap rounded-[var(--radius)] px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50", {
  variants: {
    variant: {
      default: "bg-[var(--primary)] text-[var(--primary-foreground)] hover:brightness-95",
      secondary: "border border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--surface-muted)]",
      ghost: "hover:bg-[var(--surface-muted)]",
      destructive: "bg-[var(--danger)] text-white hover:brightness-95",
      link: "h-auto px-0 text-[var(--primary)] underline-offset-4 hover:underline",
    },
    size: { default: "h-9", sm: "h-8 px-2.5 text-xs", lg: "h-10 px-5", icon: "h-9 w-9 px-0" },
  },
  defaultVariants: { variant: "default", size: "default" },
});

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> { asChild?: boolean }
export function Button({ className, variant, size, asChild = false, ...props }: ButtonProps) {
  const Comp = asChild ? Slot : "button";
  return <Comp className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
