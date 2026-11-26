# 任务 6：顾问页主题与中英切换

<task-brief>

## 1. 在哪里

- **阶段 7 会话能像样地用**。
- **本任务收尾 R-9**：顾问页可切明暗与中英。两件事，两个提交。
- **开工前提**：任务 3、5 已提交。**后续**：任务 7。

## 2. 要知道的

**先读**

- `C:\Users\USER\Desktop\chat-demo\src\app\theme.ts` 与 `i18n\index.ts`：跟随系统与取词写法。
- `apps/web/app/globals.css` 从「迪礼顾问」段起：哪些颜色写死了。
- `apps/web/components/agent/`：所有界面文字。
- `apps/web/features/agent-chat/markdown/mermaid.ts`：图表主题写在哪。

**已定**

- 设置存 `localStorage` 键 `dilee.agent.settings`：`theme` 为 `system|light|dark`（默认 `system`），`locale` 为 `zh-CN|en-US`（默认 `zh-CN`）。读到坏值用默认。
- 工具栏加一个设置菜单，两组单选。
- 主题只作用于顾问工作区与它的弹窗，用 `data-agent-theme="light|dark"`；深色样式写 CSS Module，不改 `globals.css` 现有规则。图表深色用 mermaid `dark`。
- 词表放 `features/agent-chat/i18n/`，中文值与现有文字逐字相同。不翻译的清单见本批 README。

**边界与接缝**

- 动顾问页、顾问组件、渲染链、新目录与测试 `agent-settings.test.tsx`。接缝：渲染页面，桩掉 `matchMedia`。

**运行**

- `npm run test:unit --workspace=@dilee/web`，`npm run typecheck`，`npm run build --workspace=@dilee/web`

**可能卡住**

- 任何现有断言因中文文字变化而红：说明默认词表抄错了，修词表，不改断言。
- 深色样式非改 `globals.css` 不可（优先级压不住）：停下上报具体选择器。

## 3. 步骤

1. 读上面四处，用一行复述任务。
2. 用例 1–3（主题），红后绿，提交：`feat(agent): 顾问页支持明暗主题`。
3. 建中文词表并替换文字，现有测试保持全绿。
4. 用例 4、5（语言），红后绿。
5. 跑全套、类型检查、构建，提交：`feat(agent): 顾问页支持中英切换`。

## 4. 用例

| # | 输入 | 期望 | 接缝 |
|---|---|---|---|
| 1 | 无设置，系统深色；另一次系统浅色 | 工作区属性依次 `dark`、`light`；系统变化时跟着变 | 页面 |
| 2 | 手动选浅色后重挂，系统深色 | 仍是 `light` | 页面 |
| 3 | 设置值是乱码 | 页面正常，按默认 | 页面 |
| 4 | 中、英词表 | 键集合完全一致，没有空值 | 词表 |
| 5 | 选 `en-US` 后看欢迎页，并重挂 | 工作区内可见文字不含汉字；仍是英文 | 页面 |

</task-brief>
