/* Portions Copyright (c) 2026 DeepSeek. MIT License, see ../LICENSE.chat-demo */
"use client";

import Prism from "prismjs";
import { useEffect, useMemo, useReducer } from "react";
import { getHighlightLang, isHighlightLoaded, loadHighlight } from "./highlight";
import { MermaidDiagram } from "./mermaid-diagram";
import styles from "./code-block.module.css";

export function CodeBlock({ code, language, streaming }: { code: string; language: string; streaming: boolean }) {
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  const lang = getHighlightLang(language);
  const loaded = lang !== null && isHighlightLoaded(lang);

  useEffect(() => {
    if (lang === null || loaded) return;
    let mounted = true;
    loadHighlight(lang).then(
      () => { if (mounted) rerender(); },
      () => undefined,
    );
    return () => { mounted = false; };
  }, [lang, loaded]);

  const markup = useMemo(() => (lang !== null && loaded ? { __html: Prism.highlight(code, Prism.languages[lang], lang) } : null), [code, lang, loaded]);

  const block = (
    <div className="agent-md-code">
      <div className="agent-md-code-head"><span>{language || "代码"}</span></div>
      <pre className={`agent-md-pre ${styles.code}`}>
        {markup === null ? <code>{code}</code> : <code dangerouslySetInnerHTML={markup} />}
      </pre>
    </div>
  );

  return !streaming && language.toLowerCase() === "mermaid" ? <MermaidDiagram code={code} fallback={block} /> : block;
}
