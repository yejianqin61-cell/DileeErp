import type { InputHTMLAttributes } from "react";
import { cn } from "../../lib/utils";

export function Input({ className, type = "text", ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input type={type} className={cn("flex h-9 w-full rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-1 text-sm text-[var(--text)] shadow-sm outline-none transition-colors placeholder:text-[var(--text-muted)] focus-visible:border-[var(--primary)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:cursor-not-allowed disabled:opacity-50", className)} {...props} />;
}
