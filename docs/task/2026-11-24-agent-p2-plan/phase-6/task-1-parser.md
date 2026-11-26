# 任务 1：依赖与解析器

<task-brief>

## 1. 在哪里

- **阶段 6 长答案不卡**：万字答案不卡，公式、图表、代码块正确。
- **本任务推进 R-10**：装依赖，得到一个把回答文本变成语法树的函数。页面此时还不用它。
- **开工前提**：无。**后续**：任务 2。

## 2. 要知道的

**先读**

- `C:\Users\USER\Desktop\chat-demo\src\services\markdown\parse.ts`：要搬的解析与节点改写。
- `apps/web/lib/agent-markdown.ts` 与它的测试：现在哪些输入必须保持安全。
- `C:\Users\USER\Desktop\chat-demo\LICENSE`：许可全文。

**已定**

- 装且只装下表，全部写死版本（`--save-exact`），`@types/*` 进 devDependencies：

| 包 | 版本 | 包 | 版本 |
|---|---|---|---|
| `mdast-util-from-markdown` | 2.0.3 | `katex` | 0.16.22 |
| `mdast-util-gfm` | 3.1.0 | `prismjs` | 1.30.0 |
| `mdast-util-math` | 3.0.0 | `mermaid` | 11.10.1 |
| `micromark-extension-gfm` | 3.0.0 | `@types/mdast` | 4.0.3 |
| `micromark-extension-llm-math` | 3.1.0 | `@types/katex`、`@types/prismjs` | 0.16.5、1.26.1 |

- 导出 `toMdAst(text)`；关掉缩进代码块；`singleDollarTextMath: false`；不搬引用角标。
- 非 `http(s)` 链接、图片、引用式链接、脚注、定义改成原文文本节点；删除线保留 `~` 原样。

**边界与接缝**

- 只动 `apps/web/package.json`、锁文件、`features/agent-chat/` 与 `apps/web/test/agent-markdown-parse.test.ts`。接缝：`toMdAst`。

**运行**

- `npm install --workspace=@dilee/web --save-exact <包@版本…>`，再 `npm audit --omit=dev`
- `npm run test:components --workspace=@dilee/web -- test/agent-markdown-parse.test.ts`，`npm run typecheck`

**可能卡住**

- 某版本装不上，或审计对**新装**的包报 high 以上：停下上报原文，不换版本。
- `singleDollarTextMath: false` 达不到用例 1–3：停下上报，不要手写正则补。

## 3. 步骤

1. 读上面三处，用一行复述任务。
2. 装依赖并跑审计，记下结果。
3. 写用例 1–3，红后绿。
4. 写用例 4–6，红后绿；加许可头与许可文件。
5. 跑全套 web 单测、类型检查。
6. 提交：`feat(agent): 引入 Markdown 语法树解析与公式、高亮、图表依赖`。

## 4. 用例

| # | 输入 | 期望 | 接缝 |
|---|---|---|---|
| 1 | `金额 $1,200 到 $1,500` | 没有公式节点，文本一字不差 | `toMdAst` |
| 2 | `$$E=mc^2$$` 单独一段 | 有公式节点，值为 `E=mc^2` | `toMdAst` |
| 3 | `勾股 \(a^2+b^2\) 成立` | 有行内公式节点，值为 `a^2+b^2` | `toMdAst` |
| 4 | `[x](javascript:alert(1))`、`[y](/hr)`、`![图](https://a.com/i.png)` | 无 link、image 节点；原文保留 | `toMdAst` |
| 5 | `[文档](https://example.com)` | 一个 link 节点，地址不变 | `toMdAst` |
| 6 | 半截输入：未闭合代码围栏、半张表格、`**半个` | 不抛异常，已到的字都在树里 | `toMdAst` |

</task-brief>
