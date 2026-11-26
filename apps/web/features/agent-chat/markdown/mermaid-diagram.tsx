/* Portions Copyright (c) 2026 DeepSeek. MIT License, see ../LICENSE.chat-demo */
"use client";

import { useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { AgentSettingsContext } from "../settings/settings";
import { renderMermaid } from "./mermaid";
import styles from "./mermaid-diagram.module.css";

type Result = { code: string; svg: string | null };

export function MermaidDiagram({ code, fallback }: { code: string; fallback: ReactNode }) {
  const [result, setResult] = useState<Result | null>(null);
  const dark = useContext(AgentSettingsContext).theme === "dark";

  useEffect(() => {
    let cancelled = false;
    renderMermaid(code, () => cancelled, ...(dark ? (["dark"] as const) : [])).then(
      (svg) => { if (!cancelled && svg) setResult({ code, svg }); },
      () => { if (!cancelled) setResult({ code, svg: null }); },
    );
    return () => { cancelled = true; };
  }, [code, dark]);

  const markup = useMemo(() => ({ __html: result?.svg ?? "" }), [result]);

  if (result?.code !== code) return fallback;
  if (result.svg === null) {
    return (
      <div>
        <p className={styles.failure}>图表无法渲染</p>
        {fallback}
      </div>
    );
  }
  return <div className={styles.diagram} data-testid="agent-diagram" dangerouslySetInnerHTML={markup} />;
}
