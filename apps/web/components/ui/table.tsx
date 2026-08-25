import type { HTMLAttributes, TableHTMLAttributes } from "react";
import { cn } from "../../lib/utils";

export function Table({ className, ...props }: TableHTMLAttributes<HTMLTableElement>) { return <div className="ui-table-wrap"><table className={cn("ui-table", className)} {...props} /></div>; }
export function TableHeader({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) { return <thead className={cn("ui-table-header", className)} {...props} />; }
export function TableBody({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) { return <tbody className={cn("ui-table-body", className)} {...props} />; }
export function TableRow({ className, ...props }: HTMLAttributes<HTMLTableRowElement>) { return <tr className={cn("ui-table-row", className)} {...props} />; }
export function TableHead({ className, ...props }: HTMLAttributes<HTMLTableCellElement>) { return <th className={cn("ui-table-head", className)} {...props} />; }
export function TableCell({ className, ...props }: HTMLAttributes<HTMLTableCellElement>) { return <td className={cn("ui-table-cell", className)} {...props} />; }
