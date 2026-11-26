"use client";

import { createContext, Fragment, memo, useContext, useMemo, type ReactNode } from "react";
import type { Code, List, ListItem, Nodes, PhrasingContent, RootContent, Table } from "mdast";
import { CodeBlock } from "../../features/agent-chat/markdown/code-block";
import { InlineMath, MathBlock } from "../../features/agent-chat/markdown/math";
import { toMdAst } from "../../features/agent-chat/markdown/parse";
import { useThrottledText } from "../../features/agent-chat/markdown/use-throttled-text";
import { cn } from "../../lib/utils";

const Streaming = createContext(false);

type BlockProps = { block: RootContent; source: string; caret: boolean };

const TopBlock = memo(
  function TopBlock({ block, caret }: BlockProps) {
    return <>{renderBlock(block, caret)}</>;
  },
  (previous, next) => previous.source === next.source && previous.caret === next.caret,
);

export function AgentMarkdown({ text, className, caret = false }: { text: string; className?: string; caret?: boolean }) {
  const shown = useThrottledText(text, caret);
  const blocks = useMemo(() => toMdAst(shown).children, [shown]);

  return (
    <div className={cn("agent-md", className)} data-testid="agent-markdown">
      <Streaming.Provider value={caret}>
        {blocks.map((block, index) => (
          <TopBlock key={index} block={block} source={shown.slice(block.position?.start.offset, block.position?.end.offset)} caret={caret && index === blocks.length - 1} />
        ))}
      </Streaming.Provider>
    </div>
  );
}

function Fence({ block }: { block: Code }) {
  return <CodeBlock code={block.value} language={block.lang ?? ""} streaming={useContext(Streaming)} />;
}

function Caret() {
  return <span className="agent-caret" aria-hidden="true" data-testid="agent-stream-caret" />;
}

function renderBlocks(blocks: RootContent[], caret: boolean): ReactNode {
  return blocks.map((block, index) => <Fragment key={index}>{renderBlock(block, caret && index === blocks.length - 1)}</Fragment>);
}

function renderBlock(block: RootContent, caret: boolean): ReactNode {
  switch (block.type) {
    case "paragraph":
      return <p className="agent-md-p">{renderInline(block.children)}{caret && <Caret />}</p>;
    case "heading": {
      const Tag = `h${block.depth}` as const;
      return <Tag className={`agent-md-h agent-md-h${block.depth}`}>{renderInline(block.children)}{caret && <Caret />}</Tag>;
    }
    case "html":
      return <p className="agent-md-p">{renderText(block.value)}{caret && <Caret />}</p>;
    case "math":
      return <MathBlock value={block.value} />;
    case "code":
      return <Fence block={block} />;
    case "list":
      return renderList(block, caret);
    case "table":
      return renderTable(block);
    case "blockquote":
      return <blockquote className="agent-md-quote">{renderBlocks(block.children, caret)}</blockquote>;
    case "thematicBreak":
      return <hr className="agent-md-hr" />;
    default:
      return null;
  }
}

function renderList(list: List, caret: boolean): ReactNode {
  const items = list.children.map((item, index) => (
    <li key={index} className="agent-md-li">{renderListItem(item, Boolean(list.spread || item.spread), caret && index === list.children.length - 1)}</li>
  ));
  return list.ordered
    ? <ol className="agent-md-ol" start={list.start && list.start !== 1 ? list.start : undefined}>{items}</ol>
    : <ul className="agent-md-ul">{items}</ul>;
}

function renderListItem(item: ListItem, spread: boolean, caret: boolean): ReactNode {
  const checkbox = typeof item.checked === "boolean" ? (item.checked ? "☑ " : "□ ") : null;
  if (item.children.length === 0) return <>{checkbox}{caret && <Caret />}</>;
  return (
    <>
      {checkbox}
      {item.children.map((child, index) => {
        const last = caret && index === item.children.length - 1;
        return (
          <Fragment key={index}>
            {child.type === "paragraph" && !spread ? <>{renderInline(child.children)}{last && <Caret />}</> : renderBlock(child, last)}
          </Fragment>
        );
      })}
    </>
  );
}

function renderTable(table: Table): ReactNode {
  const [header, ...rows] = table.children;
  const columns = Array.from({ length: header?.children.length ?? 0 }, (_, index) => index);
  const style = (column: number) => {
    const align = table.align?.[column];
    return align ? { textAlign: align } : undefined;
  };
  return (
    <div className="agent-md-table-wrap" data-testid="agent-markdown-table">
      <table className="agent-md-table">
        <thead>
          <tr>{columns.map((column) => <th key={column} style={style(column)}>{renderInline(header.children[column].children)}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {columns.map((column) => <td key={column} style={style(column)}>{renderInline(row.children[column]?.children ?? [])}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function renderText(value: string): ReactNode {
  return value.split(/\r?\n/).map((line, index) => <Fragment key={index}>{index > 0 && <br />}{line}</Fragment>);
}

function renderInline(nodes: PhrasingContent[]): ReactNode {
  return nodes.map((node, index) => <Fragment key={index}>{renderPhrase(node)}</Fragment>);
}

function renderPhrase(node: Extract<Nodes, PhrasingContent>): ReactNode {
  switch (node.type) {
    case "text":
    case "html":
      return renderText(node.value);
    case "inlineMath":
      return <InlineMath value={node.value} />;
    case "break":
      return <br />;
    case "inlineCode":
      return <code className="agent-md-code-inline">{node.value}</code>;
    case "strong":
      return <strong>{renderInline(node.children)}</strong>;
    case "emphasis":
      return <em>{renderInline(node.children)}</em>;
    case "link":
      return (
        <a className="agent-md-link" href={node.url} target="_blank" rel="noreferrer noopener">
          {renderInline(node.children)}
        </a>
      );
    default:
      return null;
  }
}
