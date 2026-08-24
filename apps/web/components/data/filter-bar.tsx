import type { ReactNode } from "react";

export function FilterBar({ children, onSubmit }: { children: ReactNode; onSubmit?: (event: React.FormEvent<HTMLFormElement>) => void }) { return <form className="filter-bar" role="search" onSubmit={onSubmit}>{children}</form>; }
