/**
 * 「迪礼顾问」对话答案的轻量 Markdown 解析器（GFM 子集，零依赖）。
 *
 * 为什么不引 react-markdown / marked：仓库硬约束不允许新增 npm 依赖；对话里真正出现的语法
 * 只有标题、列表、表格、代码块和少量行内格式，手写解析器足够可控，也不用处理第三方库的 SSR 差异。
 *
 * 为什么所有分支都必须容错：答案由后端 SSE 增量累积，前端每次拿到的都可能是一段**没写完**的文本
 * （半张表格、未闭合的代码围栏、只打了左半边星号的粗体）。解析器绝不能抛异常把整个对话区打挂，
 * 找不到闭合标记时一律退化成纯文本，让已经到达的内容照常显示。
 *
 * 输出是纯数据结构而不是 HTML 字符串，组件用 React 元素渲染：裸 HTML 天然只是文本节点，
 * 不存在 dangerouslySetInnerHTML 的注入面；链接也在这里先过一遍协议白名单。
 */

export type MdInline =
  | { type: "text"; value: string }
  | { type: "strong"; children: MdInline[] }
  | { type: "em"; children: MdInline[] }
  | { type: "code"; value: string }
  | { type: "link"; href: string; children: MdInline[] }
  | { type: "break" };

/** 列表项只承载行内内容：ERP 回答里的列表基本是一行一条，不做块级嵌套可以少一层递归。 */
export type MdListItem = { children: MdInline[] };

export type MdBlock =
  | { type: "paragraph"; children: MdInline[] }
  | { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; children: MdInline[] }
  | { type: "code"; language: string; value: string }
  | { type: "list"; ordered: boolean; start: number; items: MdListItem[] }
  | { type: "table"; align: Array<"left" | "center" | "right" | null>; header: MdInline[][]; rows: MdInline[][][] }
  | { type: "blockquote"; blocks: MdBlock[] }
  | { type: "hr" };

type TableAlign = "left" | "center" | "right" | null;

/** 行内递归上限：只防病态输入（如成千上万个 `*`）把调用栈打爆，正常答案远到不了这一层。 */
const MAX_INLINE_DEPTH = 8;

/** 可以反斜杠转义的标点，只覆盖本解析器认识的语法字符。 */
const ESCAPABLE_CHARS = "\\`*_{}[]()#+-.!>|~";

/** 行内列表项续行：至少两个空格缩进才算「同一项的第二行」，否则视为列表结束。 */
const LIST_CONTINUATION_RE = /^[ \t]{2,}/;

const HR_RE = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;

// ---------------------------------------------------------------------------
// 块级
// ---------------------------------------------------------------------------

export function parseMarkdown(source: string): MdBlock[] {
  if (!source || source.trim() === "") return [];
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  try {
    return parseBlocks(lines);
  } catch {
    // 兜底：流式输入可能千奇百怪，任何解析意外都不该把整段对话打挂 —— 退回纯文本。
    return [{ type: "paragraph", children: [{ type: "text", value: source }] }];
  }
}

function parseBlocks(lines: string[]): MdBlock[] {
  const blocks: MdBlock[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (isBlankLine(line)) {
      // 连续空行在这里被整段折叠，不会产生空段落。
      index += 1;
      continue;
    }

    const fence = matchFenceOpen(line);
    if (fence) {
      index = consumeCodeFence(lines, index, fence, blocks);
      continue;
    }

    const heading = matchHeading(line);
    if (heading) {
      blocks.push({ type: "heading", level: heading.level, children: parseInline(heading.content) });
      index += 1;
      continue;
    }

    if (HR_RE.test(line)) {
      blocks.push({ type: "hr" });
      index += 1;
      continue;
    }

    if (isBlockquoteLine(line)) {
      index = consumeBlockquote(lines, index, blocks);
      continue;
    }

    if (isTableStart(lines, index)) {
      index = consumeTable(lines, index, blocks);
      continue;
    }

    if (matchListMarker(line)) {
      index = consumeList(lines, index, blocks);
      continue;
    }

    index = consumeParagraph(lines, index, blocks);
  }
  return blocks;
}

type FenceMatch = { char: "`" | "~"; length: number; info: string };

function matchFenceOpen(line: string): FenceMatch | null {
  const match = /^ {0,3}(`{3,}|~{3,})[ \t]*(.*)$/.exec(line);
  if (!match) return null;
  return { char: match[1][0] as "`" | "~", length: match[1].length, info: match[2].trim() };
}

function matchFenceClose(line: string): { char: "`" | "~"; length: number } | null {
  const match = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
  if (!match) return null;
  return { char: match[1][0] as "`" | "~", length: match[1].length };
}

function consumeCodeFence(lines: string[], start: number, fence: FenceMatch, blocks: MdBlock[]): number {
  const valueLines: string[] = [];
  let index = start + 1;
  while (index < lines.length) {
    const close = matchFenceClose(lines[index]);
    if (close && close.char === fence.char && close.length >= fence.length) {
      index += 1;
      break;
    }
    valueLines.push(lines[index]);
    index += 1;
  }
  // 围栏没闭合时循环会一直吃到末尾：正好满足「流式未完成当代码块渲染剩余内容」。
  // 语言名只取 info string 的第一个 token，```ts title=... 这类附加信息不影响代码块语义。
  const language = fence.info.split(/\s+/)[0];
  blocks.push({ type: "code", language, value: valueLines.join("\n") });
  return index;
}

type HeadingMatch = { level: 1 | 2 | 3 | 4 | 5 | 6; content: string };

function matchHeading(line: string): HeadingMatch | null {
  const match = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/.exec(line);
  if (!match) return null;
  const level = match[1].length as 1 | 2 | 3 | 4 | 5 | 6;
  // 支持 GFM 的收尾 #（## 标题 ##）；只认「空格 + # + 行尾」，正文中间的 # 不受影响。
  const content = (match[2] ?? "").replace(/[ \t]+#+[ \t]*$/, "").trim();
  return { level, content };
}

function isBlockquoteLine(line: string): boolean {
  return /^ {0,3}>/.test(line);
}

function consumeBlockquote(lines: string[], start: number, blocks: MdBlock[]): number {
  const inner: string[] = [];
  let index = start;
  while (index < lines.length) {
    const line = lines[index];
    if (isBlockquoteLine(line)) {
      inner.push(line.replace(/^ {0,3}> ?/, ""));
      index += 1;
      continue;
    }
    if (isBlankLine(line)) {
      // 只有「空行后面还是引用行」才说明引用里夹了空行；否则这里的空行属于引用之后的正文。
      let lookahead = index + 1;
      while (lookahead < lines.length && isBlankLine(lines[lookahead])) lookahead += 1;
      if (lookahead < lines.length && isBlockquoteLine(lines[lookahead])) {
        inner.push("");
        index += 1;
        continue;
      }
    }
    break;
  }
  blocks.push({ type: "blockquote", blocks: parseBlocks(inner) });
  return index;
}

type ListMarker = { ordered: boolean; start: number; content: string };

function matchListMarker(line: string): ListMarker | null {
  const unordered = /^ {0,3}([-*+])[ \t]+(.*)$/.exec(line);
  if (unordered) return { ordered: false, start: 1, content: unordered[2] };
  // 同时接受 `1.` 和 `1)` 两种有序列表写法（模型两种都会输出）。
  const ordered = /^ {0,3}(\d{1,9})([.)])[ \t]+(.*)$/.exec(line);
  if (ordered) return { ordered: true, start: Number.parseInt(ordered[1], 10), content: ordered[3] };
  return null;
}

function consumeList(lines: string[], start: number, blocks: MdBlock[]): number {
  const first = matchListMarker(lines[start]);
  if (!first) return start + 1; // 调用前已判断过，这里只是让类型收窄。

  const items: MdListItem[] = [];
  let index = start;
  while (index < lines.length) {
    const marker = matchListMarker(lines[index]);
    if (!marker || marker.ordered !== first.ordered) break;

    const itemLines = [marker.content.trim()];
    index += 1;
    // 缩进续行并入同一项（按行内换行渲染）；空行直接结束列表 —— 这里不支持 loose list 的块级嵌套。
    while (index < lines.length) {
      const line = lines[index];
      if (isBlankLine(line) || matchListMarker(line) || !LIST_CONTINUATION_RE.test(line)) break;
      itemLines.push(line.trim());
      index += 1;
    }
    items.push({ children: parseInline(itemLines.join("\n")) });
  }

  // start 取第一个序号：`3. / 4.` 渲染出来也从 3 开始，符合模型表述的「第 3 条」。
  blocks.push({ type: "list", ordered: first.ordered, start: first.start, items });
  return index;
}

function isTableStart(lines: string[], index: number): boolean {
  if (index + 1 >= lines.length) return false;
  const headerLine = lines[index];
  const delimiterLine = lines[index + 1];
  // 两边都必须带 `|`：否则单独一行 `---` 会被误判成单列表格（它应该是水平线）。
  if (!headerLine.includes("|") || !delimiterLine.includes("|")) return false;
  const headerCells = splitTableRow(headerLine);
  const delimiterCells = splitTableRow(delimiterLine);
  if (headerCells.length === 0 || headerCells.length !== delimiterCells.length) return false;
  return delimiterCells.every((cell) => /^:?-+:?$/.test(cell));
}

function consumeTable(lines: string[], start: number, blocks: MdBlock[]): number {
  // 列数以表头为准：行不足补空、超出截断，流式最后一行只有半截时也按已有单元格渲染。
  const headerCells = splitTableRow(lines[start]);
  const columns = headerCells.length;
  const align = splitTableRow(lines[start + 1]).map(parseTableAlign);
  const header = headerCells.map((cell) => parseInline(cell));
  const rows: MdInline[][][] = [];

  let index = start + 2;
  while (index < lines.length) {
    const line = lines[index];
    if (isBlankLine(line) || !line.includes("|") || HR_RE.test(line)) break;
    const cells = splitTableRow(line);
    // 流式时可能只到了行首的 `|`，这不是一条真实数据行，跳过比渲染整行空白好。
    if (cells.every((cell) => cell === "")) break;
    const row = Array.from({ length: columns }, (_, column) => (cells[column] ?? "").trim());
    rows.push(row.map((cell) => parseInline(cell)));
    index += 1;
  }

  blocks.push({ type: "table", align, header, rows });
  return index;
}

function parseTableAlign(cell: string): TableAlign {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  if (left && right) return "center";
  if (left) return "left";
  if (right) return "right";
  return null;
}

function splitTableRow(line: string): string[] {
  let body = line.trim();
  if (body.startsWith("|")) body = body.slice(1);
  if (body.endsWith("|") && !body.endsWith("\\|")) body = body.slice(0, -1);

  const cells: string[] = [];
  let current = "";
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    // 单元格里的 `\|` 是转义的竖线，不能当分隔符。
    if (char === "\\" && body[index + 1] === "|") {
      current += "|";
      index += 1;
      continue;
    }
    if (char === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  cells.push(current.trim());
  return cells;
}

function consumeParagraph(lines: string[], start: number, blocks: MdBlock[]): number {
  const paragraphLines: string[] = [];
  let index = start;
  while (index < lines.length) {
    const line = lines[index];
    if (isBlankLine(line)) break;
    // 段落内出现新的块级起始（标题、列表、围栏…）就截断：模型常在列表前不空行。
    if (index > start && startsBlock(lines, index)) break;
    paragraphLines.push(line.trim());
    index += 1;
  }
  const children = parseInline(paragraphLines.join("\n"));
  if (children.length > 0) blocks.push({ type: "paragraph", children });
  return index;
}

function startsBlock(lines: string[], index: number): boolean {
  const line = lines[index];
  if (isBlankLine(line)) return true;
  if (matchFenceOpen(line)) return true;
  if (matchHeading(line)) return true;
  if (HR_RE.test(line)) return true;
  if (isBlockquoteLine(line)) return true;
  if (matchListMarker(line)) return true;
  return isTableStart(lines, index);
}

function isBlankLine(line: string): boolean {
  return line.trim() === "";
}

// ---------------------------------------------------------------------------
// 行内
// ---------------------------------------------------------------------------

function parseInline(source: string, depth = 0): MdInline[] {
  const nodes: MdInline[] = [];
  let buffer = "";

  const pushText = (value: string) => {
    if (!value) return;
    const last = nodes[nodes.length - 1];
    if (last && last.type === "text") {
      // 相邻文本合并成一个节点：数据结构更干净，测试也能直接断言。
      nodes[nodes.length - 1] = { type: "text", value: last.value + value };
      return;
    }
    nodes.push({ type: "text", value });
  };
  const flush = () => {
    if (buffer) {
      pushText(buffer);
      buffer = "";
    }
  };

  let index = 0;
  while (index < source.length) {
    const char = source[index];

    if (char === "\n") {
      // 对话答案里的换行通常有语义（一行一条），按 break 渲染而不是拼成空格。
      flush();
      nodes.push({ type: "break" });
      index += 1;
      continue;
    }

    if (char === "\\") {
      const next = source[index + 1];
      if (next && ESCAPABLE_CHARS.includes(next)) {
        buffer += next;
        index += 2;
        continue;
      }
      buffer += char;
      index += 1;
      continue;
    }

    if (char === "`") {
      const span = readCodeSpan(source, index);
      if (span) {
        flush();
        nodes.push({ type: "code", value: span.value });
        index = span.next;
        continue;
      }
      buffer += char;
      index += 1;
      continue;
    }

    // 图片语法不支持，整段按原文保留：既不加载外链图片，也不把 `[alt](url)` 误当链接。
    if (char === "!" && source[index + 1] === "[" && depth < MAX_INLINE_DEPTH) {
      const image = readImageLiteral(source, index);
      if (image) {
        flush();
        pushText(image.value);
        index = image.next;
        continue;
      }
      buffer += char;
      index += 1;
      continue;
    }

    if (char === "*" && depth < MAX_INLINE_DEPTH) {
      const strong = readStrong(source, index, depth);
      if (strong) {
        flush();
        nodes.push({ type: "strong", children: strong.children });
        index = strong.next;
        continue;
      }
      const em = readEmphasis(source, index, "*", depth);
      if (em) {
        flush();
        nodes.push({ type: "em", children: em.children });
        index = em.next;
        continue;
      }
      buffer += char;
      index += 1;
      continue;
    }

    if (char === "_" && depth < MAX_INLINE_DEPTH) {
      // `__` 是 GFM 的另一种粗体写法，本解析器不支持：成对保留为原文，避免吞字或错配。
      if (source[index + 1] === "_") {
        buffer += "__";
        index += 2;
        continue;
      }
      const em = readEmphasis(source, index, "_", depth);
      if (em) {
        flush();
        nodes.push({ type: "em", children: em.children });
        index = em.next;
        continue;
      }
      buffer += char;
      index += 1;
      continue;
    }

    if (char === "[" && depth < MAX_INLINE_DEPTH) {
      const link = readLink(source, index, depth);
      if (link) {
        flush();
        const [only] = link.nodes;
        if (link.nodes.length === 1 && only.type === "text") pushText(only.value);
        else nodes.push(...link.nodes);
        index = link.next;
        continue;
      }
      buffer += char;
      index += 1;
      continue;
    }

    buffer += char;
    index += 1;
  }

  flush();
  return nodes;
}

function isWordChar(char: string): boolean {
  return /[A-Za-z0-9]/.test(char);
}

type InlineToken = { value: string; next: number };
type ChildrenToken = { children: MdInline[]; next: number };

function readCodeSpan(source: string, start: number): InlineToken | null {
  let run = 0;
  while (source[start + run] === "`") run += 1;
  const contentStart = start + run;

  let cursor = contentStart;
  while (cursor < source.length) {
    const found = source.indexOf("`", cursor);
    if (found < 0) return null;
    let closeRun = 0;
    while (source[found + closeRun] === "`") closeRun += 1;
    if (closeRun === run) {
      return { value: normalizeCodeSpan(source.slice(contentStart, found)), next: found + closeRun };
    }
    cursor = found + closeRun;
  }
  return null;
}

function normalizeCodeSpan(value: string): string {
  const flattened = value.replace(/\n/g, " ");
  // CommonMark：首尾各一个空格会去掉（` `` `a` `` ` 这类需要保留的除外）。
  if (flattened.length > 2 && flattened.startsWith(" ") && flattened.endsWith(" ") && flattened.trim() !== "") {
    return flattened.slice(1, -1);
  }
  return flattened;
}

function readStrong(source: string, start: number, depth: number): ChildrenToken | null {
  if (source[start] !== "*" || source[start + 1] !== "*") return null;

  // ***粗斜体***：先整体识别，否则闭合处的 ** 会把内容切成 "*粗斜体" 这样的残片。
  if (source[start + 2] === "*") {
    const triple = readDelimited(source, start, "***", depth);
    if (triple) return { children: [{ type: "em", children: triple.children }], next: triple.next };
  }

  return readDelimited(source, start, "**", depth);
}

function readEmphasis(source: string, start: number, marker: "*" | "_", depth: number): ChildrenToken | null {
  if (source[start] !== marker) return null;
  const next = source[start + 1];
  // 起始标记后面紧跟空白不算强调（否则 `a * b` 这种算式会被吃掉）。
  if (next === undefined || /\s/.test(next)) return null;
  // 单个 * 不处理 **粗体** 的起始半截。
  if (marker === "*" && next === "*") return null;
  // `snake_case` 不是斜体：_ 不能从单词中间开始。
  if (marker === "_") {
    const previous = source[start - 1];
    if (previous !== undefined && isWordChar(previous)) return null;
  }

  const contentStart = start + 1;
  let cursor = contentStart + 1;
  while (cursor < source.length) {
    if (source[cursor] === marker) {
      // 闭合标记不能贴着空白；* 的闭合也不能是 ** 粗体的一部分。
      const partOfStrong = marker === "*" && (source[cursor + 1] === "*" || source[cursor - 1] === "*");
      const closingOk = !partOfStrong && !/\s/.test(source[cursor - 1]);
      const boundaryOk = marker !== "_" || source[cursor + 1] === undefined || !isWordChar(source[cursor + 1]);
      if (closingOk && boundaryOk) {
        const inner = source.slice(contentStart, cursor);
        if (inner.trim() !== "") return { children: parseInline(inner, depth + 1), next: cursor + 1 };
      }
    }
    cursor += 1;
  }
  return null;
}

function readDelimited(source: string, start: number, delimiter: string, depth: number): ChildrenToken | null {
  const contentStart = start + delimiter.length;
  if (contentStart >= source.length) return null;
  // 分隔符后必须是内容而不是空白，避免把 `** 星号 **` 这种半截当粗体。
  if (/\s/.test(source[contentStart])) return null;

  for (let cursor = contentStart; cursor <= source.length - delimiter.length; cursor += 1) {
    if (cursor === contentStart || !source.startsWith(delimiter, cursor)) continue;
    const inner = source.slice(contentStart, cursor);
    if (inner.trim() === "" || /\s/.test(source[cursor - 1])) continue;
    return { children: parseInline(inner, depth + 1), next: cursor + delimiter.length };
  }
  return null;
}

function readLink(source: string, start: number, depth: number): { nodes: MdInline[]; next: number } | null {
  const labelEnd = findClosingBracket(source, start);
  if (labelEnd < 0 || source[labelEnd + 1] !== "(") return null;
  const destinationEnd = findClosingParen(source, labelEnd + 1);
  // 流式时 `[文本](https://exa` 还没收到右括号：整段当普通文本，等下一个增量再升级成链接。
  if (destinationEnd < 0) return null;

  const raw = source.slice(start, destinationEnd + 1);
  const href = sanitizeHref(source.slice(labelEnd + 2, destinationEnd));
  if (!href) {
    // 非 http(s) 一律降级为原文：不生成可点击链接，也不静默丢掉用户看到的内容。
    return { nodes: [{ type: "text", value: raw }], next: destinationEnd + 1 };
  }
  return { nodes: [{ type: "link", href, children: parseInline(source.slice(start + 1, labelEnd), depth + 1) }], next: destinationEnd + 1 };
}

function readImageLiteral(source: string, start: number): InlineToken | null {
  const altEnd = findClosingBracket(source, start + 1);
  if (altEnd < 0 || source[altEnd + 1] !== "(") return null;
  const destinationEnd = findClosingParen(source, altEnd + 1);
  if (destinationEnd < 0) return null;
  return { value: source.slice(start, destinationEnd + 1), next: destinationEnd + 1 };
}

function findClosingBracket(source: string, start: number): number {
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === "[") depth += 1;
    else if (char === "]") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function findClosingParen(source: string, start: number): number {
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/**
 * 链接协议白名单：只放行 http(s) 绝对地址。
 * `javascript:` / `data:` / 相对路径都降级成纯文本，避免模型输出被当成可执行/站内导航链接。
 */
function sanitizeHref(rawDestination: string): string | null {
  const withoutBrackets = rawDestination.trim().replace(/^<|>$/g, "").trim();
  // 目标里可能跟 Markdown 的 title（`(https://a.com "标题")`），取第一个空白前的部分。
  const candidate = withoutBrackets.split(/\s+/)[0] ?? "";
  if (!/^https?:\/\/[^\s]+$/i.test(candidate)) return null;
  if (/[\u0000-\u001f\u007f]/.test(candidate)) return null;
  return candidate;
}
