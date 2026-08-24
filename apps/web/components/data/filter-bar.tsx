import type { ReactNode } from "react";

export function FilterBar({ children, onSubmit, onReset }: { children: ReactNode; onSubmit?: (event: React.FormEvent<HTMLFormElement>) => void; onReset?: () => void }) { return <form className="filter-bar" role="search" onSubmit={onSubmit} onReset={(event) => { event.preventDefault(); onReset?.(); }}>{children}</form>; }
