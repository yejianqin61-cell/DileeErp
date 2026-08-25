import type { InputHTMLAttributes } from "react";
import { cn } from "../../lib/utils";

export function FileInput({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input type="file" className={cn("ui-file-input", className)} {...props} />;
}
