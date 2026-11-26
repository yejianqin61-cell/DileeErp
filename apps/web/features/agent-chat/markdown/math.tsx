/* Portions Copyright (c) 2026 DeepSeek. MIT License, see ../LICENSE.chat-demo */
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ensureKatex, type Katex } from "./katex";
import styles from "./math.module.css";

function useKatex(): Katex | null {
  const [katex, setKatex] = useState<Katex | null>(null);
  useEffect(() => {
    let mounted = true;
    void Promise.resolve(ensureKatex()).then(
      (loaded) => { if (mounted) setKatex(() => loaded); },
      () => undefined,
    );
    return () => { mounted = false; };
  }, []);
  return katex;
}

function useMathMarkup(value: string, display: boolean): { __html: string } | null {
  const katex = useKatex();
  const previous = useRef<{ __html: string } | null>(null);
  return useMemo(() => {
    if (!katex) return null;
    try {
      previous.current = { __html: katex.renderToString(value, { displayMode: display, throwOnError: true, strict: false, trust: false }) };
    } catch {
      return previous.current;
    }
    return previous.current;
  }, [katex, value, display]);
}

export function MathBlock({ value }: { value: string }) {
  const markup = useMathMarkup(value, true);
  return markup === null
    ? <p className="agent-md-p">{value}</p>
    : <div className={styles.block} dangerouslySetInnerHTML={markup} />;
}

export function InlineMath({ value }: { value: string }) {
  const markup = useMathMarkup(value, false);
  return markup === null ? <>{value}</> : <span dangerouslySetInnerHTML={markup} />;
}
