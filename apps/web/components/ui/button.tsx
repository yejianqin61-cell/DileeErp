import { Slot } from "@radix-ui/react-slot";
import type { ButtonHTMLAttributes } from "react";
import { cn } from "../../lib/utils";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  asChild?: boolean;
  variant?: "default" | "secondary" | "ghost" | "destructive" | "link";
  size?: "default" | "sm" | "lg" | "icon";
}
export function Button({ className, variant, size, asChild = false, ...props }: ButtonProps) {
  const Comp = asChild ? Slot : "button";
  const variantClass = { default: "ui-button-primary", secondary: "ui-button-secondary", ghost: "ui-button-ghost", destructive: "ui-button-danger", link: "ui-button-link" }[variant ?? "default"];
  const sizeClass = { default: "", sm: "ui-button-sm", lg: "ui-button-lg", icon: "ui-button-icon" }[size ?? "default"];
  return <Comp className={cn("ui-button", variantClass, sizeClass, className)} {...props} />;
}
