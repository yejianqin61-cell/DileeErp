# P2 阶段 6：长答案不卡

计划：[P2 施工计划 v1.7](../plan.md) 阶段 6。设计：[P2 设计 v1.7](../../../design/dilee-consultant-p2-tool-catalog-2026-11-24.md) §6.1、§6.2、§7.2。

**这一批只换回答正文的渲染。** 目标：万字答案流式期间不卡，公式、图表、代码块显示正确。
没有会话体验特性，后端一行不改。

覆盖需求：R-10。

## 任务

| # | 任务 | 产物 | 依赖 |
|---|---|---|---|
| 1 | [依赖与解析器](task-1-parser.md) | `features/agent-chat/markdown/parse.ts` | — |
| 2 | [渲染器改读语法树](task-2-renderer.md) | `agent-markdown.tsx`，删手写解析器 | 1 |
| 3 | [流式节流](task-3-throttle.md) | `use-throttled-text.ts` | 2 |
| 4 | [公式](task-4-math.md) | KaTeX 接入 | 2 |
| 5 | [代码高亮](task-5-highlight.md) | Prism 接入 | 2 |
| 6 | [图表](task-6-mermaid.md) | Mermaid 接入 | 5 |
| 7 | [长答案浏览器用例](task-7-long-answer.md) | `agent-long-answer.spec.mjs` | 3、4、6 |

按序做：1 → 2 → 3 → 4 → 5 → 6 → 7。

## 本批已定（实施者不得重开）

| 决定 | 内容 | 出处 |
|---|---|---|
| 新依赖 | 允许从 npm 下载安装，清单与版本只限任务 1 的表 | 用户 2026-11-26 |
| 单个 `$` | **不算公式**。只认 `$$…$$`、`\(…\)`、`\[…\]` | 用户 2026-11-26 |
| 耗时上限 | 真浏览器里流式期间最长的一个长任务 **不超过 100 毫秒** | 用户 2026-11-26 |
| 落位 | 解析、节流、加载器放 `apps/web/features/agent-chat/markdown/`；渲染组件仍是 `components/agent/agent-markdown.tsx` | 设计 §6.2 |
| 许可 | 从 chat-demo 搬的文件首行加许可头，许可全文存 `features/agent-chat/LICENSE.chat-demo` | 设计 §7.2 |
| 样式 | 沿用 `.agent-md-*` 类名；新样式用 CSS Modules，不写进 `globals.css` | 设计 §6.2 |
| 安全 | 裸 HTML 只当文本；只有 `http(s)` 绝对地址成链接；图片不加载，显示原文 | 现有渲染契约 |
| 主题 | 只做浅色，深色在阶段 7 | 计划阶段 7 |
| 注释 | 除许可头外不写散文注释，搬来的注释删掉 | 设计 §7.2 |

搬移来源（只读）：`C:\Users\USER\Desktop\chat-demo\src`。许可头固定写法：

```ts
/* Portions Copyright (c) 2026 DeepSeek. MIT License, see ../LICENSE.chat-demo */
```

## 命令（仓库根目录执行）

```bash
npm run typecheck
npm run test:unit --workspace=@dilee/web
npm run build --workspace=@dilee/web
```

基线（阶段 5 结束时）：web lib 470、web 组件 1453，全绿；`/agent` 首屏 JS 146 kB。
不要读取或复制任何 `.env`。
