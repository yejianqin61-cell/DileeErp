/* Portions Copyright (c) 2026 DeepSeek. MIT License, see ../LICENSE.chat-demo */
import type { Nodes, Parent, Root, RootContent, Text } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { mathFromMarkdown } from "mdast-util-math";
import { gfm } from "micromark-extension-gfm";
import { math } from "micromark-extension-llm-math";

const SAFE_URL_RE = /^https?:\/\/[^\s\u0000-\u001f\u007f]+$/i;

const text = (value: string): Text => ({ type: "text", value });

export function toMdAst(input: string): Root {
  const ast = fromMarkdown(input, {
    extensions: [{ ...gfm(), disable: { null: ["codeIndented"] } }, math({ singleDollarTextMath: false })],
    mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()],
  });
  const raw = (node: Nodes) => input.slice(node.position?.start.offset, node.position?.end.offset);
  const simplify = (node: Nodes): Nodes[] => {
    if ("children" in node) {
      (node as Parent).children = node.children.flatMap(simplify) as RootContent[];
    }
    switch (node.type) {
      case "link":
        return SAFE_URL_RE.test(node.url) ? [node] : [text(raw(node))];
      case "delete": {
        const delimiter = raw(node).match(/^~+/)?.[0] ?? "";
        return [text(delimiter), ...node.children, text(delimiter)];
      }
      case "image":
      case "footnoteReference":
      case "imageReference":
      case "linkReference":
        return [text(raw(node))];
      case "footnoteDefinition":
      case "definition":
        return [{ type: "paragraph", children: [text(raw(node))] }];
      default:
        return [node];
    }
  };
  simplify(ast);
  return ast;
}
