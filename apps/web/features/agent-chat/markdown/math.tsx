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

function useMathHtml(value: string, display: boolean): string | null {
  const katex = useKatex();
  const previous = useRef<string | null>(null);
  return useMemo(() => {
    if (!katex) return null;
    try {
      previous.current = katex.renderToString(value, { displayMode: display, throwOnError: true, strict: false, trust: false });
    } catch {
      return previous.current;
    }
    return previous.current;
  }, [katex, value, display]);
}

export function MathBlock({ value }: { value: string }) {
  const html = useMathHtml(value, true);
  return html === null
    ? <p className="agent-md-p">{value}</p>
    : <div className={styles.block} dangerouslySetInnerHTML={{ __html: html }} />;
}

export function InlineMath({ value }: { value: string }) {
  const html = useMathHtml(value, false);
  return html === null ? <>{value}</> : <span dangerouslySetInnerHTML={{ __html: html }} />;
}
