// 「迪礼顾问」答案 Markdown 解析器（lib/agent-markdown.ts）的单元测试。
//
// 与 lib 下其它纯函数一致用 node:test：解析器不依赖 DOM，Node 24 原生类型擦除可直接跑 .ts。
// 断言分两类：GFM 子集的正确性，以及「SSE 流式未完成输入不抛异常、按已有内容渲染」这条真实数据流约束。
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMarkdown } from "./agent-markdown.ts";

/** 把行内节点拍平成纯文本，便于断言（break 记作换行，代码/链接取内容）。 */
function inlineText(nodes) {
  return nodes
    .map((node) => {
      if (node.type === "text") return node.value;
      if (node.type === "break") return "\n";
      if (node.type === "code") return node.value;
      return inlineText(node.children);
    })
    .join("");
}

/** 递归收集行内节点类型，用来断言「没有生成 link」之类的安全约束。 */
function inlineTypes(nodes) {
  return nodes.flatMap((node) => [node.type, ...(node.children ? inlineTypes(node.children) : [])]);
}

function blockTypes(blocks) {
  return blocks.map((block) => block.type);
}

test("段落：单换行渲染为 break，空行分段，连续空行折叠", () => {
  const blocks = parseMarkdown("第一行\n第二行\n\n\n\n第二段");
  assert.deepEqual(blockTypes(blocks), ["paragraph", "paragraph"]);
  assert.deepEqual(blocks[0].children, [
    { type: "text", value: "第一行" },
    { type: "break" },
    { type: "text", value: "第二行" },
  ]);
  assert.equal(inlineText(blocks[1].children), "第二段");
});

test("标题：# 到 ###### 都识别，行内格式照常解析", () => {
  const blocks = parseMarkdown("# 一级\n\n### 三级 **重点**\n\n###### 六级");
  assert.deepEqual(
    blocks.map((block) => (block.type === "heading" ? block.level : block.type)),
    [1, 3, 6],
  );
  assert.equal(inlineText(blocks[1].children), "三级 重点");
  assert.ok(inlineTypes(blocks[1].children).includes("strong"));
  // 没有空格分隔的 # 不是标题，避免把「#1 订单」误判。
  assert.deepEqual(blockTypes(parseMarkdown("#1 订单")), ["paragraph"]);
});

test("行内：粗体 / 斜体 / 行内代码 / 链接", () => {
  const [block] = parseMarkdown("**粗体**、*斜体*、_强调_、`code`、[文档](https://example.com/a)");
  assert.equal(block.type, "paragraph");
  const types = inlineTypes(block.children);
  assert.ok(types.includes("strong"));
  assert.equal(types.filter((type) => type === "em").length, 2);
  assert.ok(types.includes("code"));
  assert.ok(types.includes("link"));

  const strong = block.children.find((node) => node.type === "strong");
  assert.equal(inlineText(strong.children), "粗体");
  const code = block.children.find((node) => node.type === "code");
  assert.equal(code.value, "code");
  const link = block.children.find((node) => node.type === "link");
  assert.equal(link.href, "https://example.com/a");
  assert.equal(inlineText(link.children), "文档");
});

test("链接只接受 http(s)：javascript: / data: / 相对路径降级为纯文本", () => {
  const source = "[点我](javascript:alert(1))、[图标](data:text/html,x)、[本地](/orders)、[也本地](docs/a.md)";
  const [block] = parseMarkdown(source);
  assert.equal(block.type, "paragraph");
  assert.ok(!inlineTypes(block.children).includes("link"), "不允许为不安全的地址生成可点击链接");
  // 降级后保留原文，用户还能看到模型写了什么，而不是被静默吞掉。
  const text = inlineText(block.children);
  for (const fragment of ["[点我](javascript:alert(1))", "[图标](data:text/html,x)", "[本地](/orders)", "[也本地](docs/a.md)"]) {
    assert.ok(text.includes(fragment));
  }
});

test("代码块：带语言、也接受 ~~~；未闭合围栏把剩余内容全部当代码", () => {
  assert.deepEqual(parseMarkdown("```ts\nconst a = 1;\nconsole.log(a);\n```"), [
    { type: "code", language: "ts", value: "const a = 1;\nconsole.log(a);" },
  ]);
  assert.deepEqual(parseMarkdown("~~~json\n{\"a\": 1}"), [{ type: "code", language: "json", value: "{\"a\": 1}" }]);
  // 流式常见：围栏还没收到闭合行。
  assert.deepEqual(parseMarkdown("```\n未闭合的代码"), [{ type: "code", language: "", value: "未闭合的代码" }]);
  assert.deepEqual(parseMarkdown("```python\nprint(1)\n```\n\n后面的段落").map((block) => block.type), ["code", "paragraph"]);
});

test("列表：无序三种标记都认；有序列表从首个序号开始（含 1) 写法）", () => {
  assert.deepEqual(parseMarkdown("- 甲\n* 乙\n+ 丙"), [
    {
      type: "list",
      ordered: false,
      start: 1,
      items: [
        { children: [{ type: "text", value: "甲" }] },
        { children: [{ type: "text", value: "乙" }] },
        { children: [{ type: "text", value: "丙" }] },
      ],
    },
  ]);

  const ordered = parseMarkdown("3. 第三\n4. 第四");
  assert.equal(ordered[0].type, "list");
  assert.equal(ordered[0].ordered, true);
  assert.equal(ordered[0].start, 3);
  assert.equal(ordered[0].items.length, 2);

  const paren = parseMarkdown("2) 第二\n3) 第三");
  assert.equal(paren[0].start, 2);
  assert.equal(paren[0].ordered, true);

  // 缩进续行并入同一项，按行内换行渲染。
  const wrapped = parseMarkdown("- 第一行\n  第二行");
  assert.equal(wrapped[0].items.length, 1);
  assert.equal(inlineText(wrapped[0].items[0].children), "第一行\n第二行");
});

test("表格：对齐、行不足补空、超出截断", () => {
  const blocks = parseMarkdown("| 名称 | 数量 | 备注 |\n| :--- | ---: | :---: |\n| 螺丝 | 12 |\n| 螺母 | 8 | 急件 | 多余 |");
  const [table] = blocks;
  assert.equal(table.type, "table");
  assert.deepEqual(table.align, ["left", "right", "center"]);
  assert.equal(table.header.length, 3);
  assert.deepEqual(
    table.rows.map((row) => row.map((cell) => inlineText(cell))),
    [
      ["螺丝", "12", ""],
      ["螺母", "8", "急件"],
    ],
  );
});

test("表格：流式残行（没有收尾竖线）按已有单元格渲染，且不抛异常", () => {
  const [table] = parseMarkdown("| 订单 | 金额 |\n| --- | ---: |\n| SO-001 | 128.5");
  assert.equal(table.type, "table");
  assert.deepEqual(table.rows.map((row) => row.map((cell) => inlineText(cell))), [["SO-001", "128.5"]]);

  // 分隔行还没写完时不能当成表格，但也不能抛。
  assert.doesNotThrow(() => parseMarkdown("| 甲 | 乙 |\n| --- |"));
  assert.deepEqual(blockTypes(parseMarkdown("| 甲 | 乙 |\n| --- |")), ["paragraph"]);
});

test("引用：多行合成一段（单换行 = break），内部递归解析块级内容", () => {
  const [quote] = parseMarkdown("> 引用第一行\n> 引用第二行");
  assert.equal(quote.type, "blockquote");
  assert.equal(quote.blocks.length, 1);
  assert.equal(inlineText(quote.blocks[0].children), "引用第一行\n引用第二行");

  const [nested] = parseMarkdown("> ## 小标题\n>\n> - 条目");
  assert.equal(nested.type, "blockquote");
  assert.deepEqual(nested.blocks.map((block) => block.type), ["heading", "list"]);
});

test("水平线：--- / *** / ___，且与前后段落分离", () => {
  assert.deepEqual(parseMarkdown("---"), [{ type: "hr" }]);
  assert.deepEqual(parseMarkdown("***"), [{ type: "hr" }]);
  assert.deepEqual(parseMarkdown("___"), [{ type: "hr" }]);
  assert.deepEqual(blockTypes(parseMarkdown("前面\n\n---\n\n后面")), ["paragraph", "hr", "paragraph"]);
});

test("空输入 / 纯空白返回空数组", () => {
  assert.deepEqual(parseMarkdown(""), []);
  assert.deepEqual(parseMarkdown("   \n\n\t "), []);
});

test("裸 HTML 标签原样当文本，不产生可执行结构", () => {
  const [block] = parseMarkdown("<script>alert(1)</script> 与 **加粗**");
  assert.equal(block.type, "paragraph");
  assert.equal(block.children[0].type, "text");
  assert.ok(block.children[0].value.includes("<script>alert(1)</script>"));
  assert.ok(inlineTypes(block.children).includes("strong"), "HTML 之后的 Markdown 仍要正常解析");
});

test("流式半截粗体 / 链接 / 行内代码都不抛异常，按原文显示", () => {
  const partialInputs = [
    "**未闭合的粗体",
    "*未闭合的斜体",
    "_未闭合的强调",
    "[未闭合的链接",
    "[文本](https://example.com/a",
    "`未闭合的行内代码",
    "```ts\nlet a = 1",
    "| 表头 | 只有表头",
    "> 未完成的引用",
    "1. 一\n2.",
    "***粗斜体***", // 这个反而是完整的，验证不会退化成残片
  ];
  for (const input of partialInputs) {
    assert.doesNotThrow(() => parseMarkdown(input), `输入不应抛异常：${input}`);
  }

  const [bold] = parseMarkdown("**未闭合的粗体");
  assert.ok(!inlineTypes(bold.children).includes("strong"));
  assert.equal(inlineText(bold.children), "**未闭合的粗体");
});
