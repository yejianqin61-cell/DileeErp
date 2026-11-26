/* Portions Copyright (c) 2026 DeepSeek. MIT License, see ../LICENSE.chat-demo */
type Mermaid = typeof import("mermaid").default;

let mermaidPromise: Promise<Mermaid> | null = null;
let renderQueue: Promise<void> = Promise.resolve();
let nextId = 0;

function loadMermaid(): Promise<Mermaid> {
  mermaidPromise ??= import("mermaid")
    .then((module) => module.default)
    .catch((error: unknown) => {
      mermaidPromise = null;
      throw error;
    });
  return mermaidPromise;
}

export const sanitizeMermaid = (code: string) => code.replace(/<((?:img|image)\s+)/gi, "&lt;$1");

export function renderMermaid(code: string, isCancelled: () => boolean): Promise<string | null> {
  const result = renderQueue.then(async () => {
    if (isCancelled() || !code.trim()) return null;
    const mermaid = await loadMermaid();
    if (isCancelled()) return null;
    mermaid.initialize({ theme: "default", securityLevel: "strict", startOnLoad: false, suppressErrorRendering: true });
    const { svg } = await mermaid.render(`agent-mermaid-${nextId++}`, sanitizeMermaid(code));
    return isCancelled() ? null : svg;
  });
  renderQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}
