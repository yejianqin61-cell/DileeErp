import type { ReactNode } from "react";

export function DetailPanel({ title, children }: { title: string; children: ReactNode }) { return <section className="panel"><div className="panel-heading"><h2>{title}</h2></div><div className="panel-body">{children}</div></section>; }
export function FormPanel({ title, children, onSubmit }: { title: string; children: ReactNode; onSubmit?: (event: React.FormEvent<HTMLFormElement>) => void }) { return <section className="panel"><div className="panel-heading"><h2>{title}</h2></div><form className="panel-body form-grid" onSubmit={onSubmit}>{children}</form></section>; }
export function AttachmentPanel() { return <section className="panel attachment-panel"><div className="panel-heading"><h2>附件</h2></div><div className="panel-body"><p>附件能力入口占位，具体文件类型和必传规则待模块负责人确认。</p></div></section>; }
