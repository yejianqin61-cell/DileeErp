/* Portions Copyright (c) 2026 DeepSeek. MIT License, see ../LICENSE.chat-demo */
export type Katex = Pick<typeof import("katex"), "renderToString">;

let katex: Katex | null = null;
let katexPromise: Promise<Katex> | null = null;

export function ensureKatex(): Katex | Promise<Katex> {
  if (katex !== null) return katex;
  katexPromise ??= Promise.all([import("katex"), import("katex/contrib/mhchem"), import("katex/dist/katex.min.css")])
    .then(([module]) => (katex = (module as unknown as { default?: Katex }).default ?? module))
    .catch((error: unknown) => {
      katexPromise = null;
      throw error;
    });
  return katexPromise;
}
