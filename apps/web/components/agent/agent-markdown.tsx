"use client";

// 对话答案的 Markdown 渲染组件（被客户端对话页使用，所以必须显式声明 client 边界）。
//
// 渲染职责：把 lib/agent-markdown.ts 解析出的纯数据结构映射成 React 元素。
// 这里刻意不拼 HTML 字符串：裸 HTML 标签由 React 当文本节点转义，从结构上避开 XSS。
// 样式全部走 globals.css 里的 .agent-md-* 语义类（本仓库没有 Tailwind，不写工具类）。

import { Fragment, useMemo, type ReactNode } from "react";
import { parseMarkdown, type MdBlock, type MdInline } from "../../lib/agent-markdown";
import { cn } from "../../lib/utils";

export function AgentMarkdown({ text, className, caret = false }: { text: string; className?: string; caret?: boolean }) {
  // 流式场景下 text 每来一个增量都会变；解析是纯函数，用 text 做缓存键即可，
  // 流式结束后（text 不再变）重复渲染不会重复解析。
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  const lastIndex = blocks.length - 1;

  return (
    <div className={cn("agent-md", className)} data-testid="agent-markdown">
      {/* caret 只挂在最后一个块里：流式光标必须贴着正文末尾，
          如果挂在容器后面会单独占一行、看起来像一段蓝色方块。 */}
      {blocks.map((block, index) => renderBlock(block, index, caret && index === lastIndex))}
    </div>
  );
}

function renderInline(nodes: MdInline[]): ReactNode {
  // 用 Fragment 包文本节点：数组里的元素都需要 key，而文本不能直接带 key。
  return nodes.map((node, index) => {
    switch (node.type) {
      case "text":
        return <Fragment key={index}>{node.value}</Fragment>;
      case "break":
        return <br key={index} />;
      case "code":
        return <code key={index} className="agent-md-code-inline">{node.value}</code>;
      case "strong":
        return <strong key={index}>{renderInline(node.children)}</strong>;
      case "em":
        return <em key={index}>{renderInline(node.children)}</em>;
      case "link":
        return (
          <a key={index} className="agent-md-link" href={node.href} target="_blank" rel="noreferrer noopener">
            {renderInline(node.children)}
          </a>
        );
    }
  });
}

function renderBlocks(blocks: MdBlock[]): ReactNode {
  return blocks.map((block, index) => renderBlock(block, index));
}

/** 流式光标：inline 元素，跟着正文末尾走，不额外占一行。 */
function Caret() {
  return <span className="agent-caret" aria-hidden="true" data-testid="agent-stream-caret" />;
}

/**
 * `caret` 只对**最后一个块**为真：段落就插在段落末尾（光标贴着最后一个字），
 * 其它块（表格/列表/代码）后面没有「正文末尾」的概念，退化成块后的独立光标。
 */
function renderBlock(block: MdBlock, key: number, caret = false): ReactNode {
  if (caret && block.type !== "paragraph") {
    return <Fragment key={key}>{renderBlock(block, key)}{Caret()}</Fragment>;
  }
  switch (block.type) {
    case "paragraph":
      return <p key={key} className="agent-md-p">{renderInline(block.children)}{caret && <Caret />}</p>;
    case "heading":
      return renderHeading(block, key);
    case "code":
      return (
        <div key={key} className="agent-md-code">
          {/* 语言名给读者一个「这是什么格式」的提示；模型没写 info string 时用「代码」兜底。 */}
          <div className="agent-md-code-head"><span>{block.language || "代码"}</span></div>
          <pre className="agent-md-pre"><code>{block.value}</code></pre>
        </div>
      );
    case "list": {
      const items = block.items.map((item, itemIndex) => (
        <li key={itemIndex} className="agent-md-li">{renderInline(item.children)}</li>
      ));
      return block.ordered
        ? <ol key={key} className="agent-md-ol" start={block.start === 1 ? undefined : block.start}>{items}</ol>
        : <ul key={key} className="agent-md-ul">{items}</ul>;
    }
    case "table":
      return (
        <div key={key} className="agent-md-table-wrap" data-testid="agent-markdown-table">
          <table className="agent-md-table">
            <thead>
              <tr>
                {block.header.map((cell, cellIndex) => (
                  <th key={cellIndex} style={tableCellStyle(block.align[cellIndex] ?? null)}>{renderInline(cell)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex} style={tableCellStyle(block.align[cellIndex] ?? null)}>{renderInline(cell)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "blockquote":
      // 引用内部仍是完整块级内容（可以有小标题、列表），所以递归走 renderBlocks。
      return <blockquote key={key} className="agent-md-quote">{renderBlocks(block.blocks)}</blockquote>;
    case "hr":
      return <hr key={key} className="agent-md-hr" />;
  }
}

function renderHeading(block: Extract<MdBlock, { type: "heading" }>, key: number): ReactNode {
  // 逐级写死标签（而不是动态拼接）让 TS/React 都能静态确认标签合法。
  const className = `agent-md-h agent-md-h${block.level}`;
  switch (block.level) {
    case 1: return <h1 key={key} className={className}>{renderInline(block.children)}</h1>;
    case 2: return <h2 key={key} className={className}>{renderInline(block.children)}</h2>;
    case 3: return <h3 key={key} className={className}>{renderInline(block.children)}</h3>;
    case 4: return <h4 key={key} className={className}>{renderInline(block.children)}</h4>;
    case 5: return <h5 key={key} className={className}>{renderInline(block.children)}</h5>;
    case 6: return <h6 key={key} className={className}>{renderInline(block.children)}</h6>;
  }
}

/** 对齐只通过内联样式表达（合同要求），列宽与边框由 globals.css 的 .agent-md-table 负责。 */
function tableCellStyle(align: "left" | "center" | "right" | null) {
  return align ? { textAlign: align } : undefined;
}
