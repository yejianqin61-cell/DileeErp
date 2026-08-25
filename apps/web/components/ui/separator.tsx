import * as SeparatorPrimitive from "@radix-ui/react-separator";
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

export function Separator({ className, orientation = "horizontal", decorative = true, ...props }: ComponentProps<typeof SeparatorPrimitive.Root>) {
  return <SeparatorPrimitive.Root decorative={decorative} orientation={orientation} className={cn("ui-separator", orientation === "horizontal" ? "ui-separator-horizontal" : "ui-separator-vertical", className)} {...props} />;
}
