# 工资台账 / 工资付款做成真·满屏表格（2026-09-15）

> **⚠️ 同日被推翻（见文末「6. 变更」）**：用户随后说「算了，工资台账和工资支付做成悬浮居中窗口页面吧，
> 版面大一点。不追求全屏了」——本文的「满屏」实现与浏览器全屏按钮已移除，
> 现状是**内容区里居中的一张大卡片**。本文保留作为决策过程的记录。

> 用户第二次强调：「财务，工资台账和工资付款都要做成全屏的表格UI，全屏！」
> （第一次说的是「做成全屏表格UI」，当时只做成了「满页表格」——表格仍是内容区里的一张卡片。）

## 1. 之前差在哪

两个二级页的结构是：

```
.content-area（max-width:1440px + padding 28/32/48）
  └ .page-root
      ├ .page-header（大标题 + 说明 + 两行按钮）   ← 约 90px
      ├ .panel.panel-body（筛选条 + 两段说明文字）  ← 约 130px
      └ .panel（panel-heading + 表格，表格内部 max-height:70vh）
```

表格实际只占可视区一半左右，其余是标题、说明与内边距 —— 所以「满页」不等于「全屏」。

## 2. 现在的样子

```
.page-fullscreen（height: calc(100dvh − 顶栏)，负边距抵消内容区内边距）
  ├ .page-fullscreen-toolbar（h1 + 状态元信息 + 导入摘要 + 按钮组，一行）
  ├ .filter-bar（月份 / 部门 / 岗位 / 员工；付款页多付款日期与方式）
  └ .panel.page-fullscreen-table → PayrollSheet（sticky 表头，纵向滚动，铺满剩余高度）
```

- `.page-fullscreen` 用 `margin: -28px -32px -48px` 抵消 `.content-area` 的内边距、`max-width: none`
  解除 1440 上限，高度按 `calc(100dvh - var(--topbar-height))` 算；
- 表格容器 `flex: 1; min-height: 0`，内部滚动条从「固定 70vh」改成撑满（`.payroll-sheet-scroll`）；
- 原来占地方的两段说明收进筛选条的 `title`（悬停可见），导入摘要这类**动态**信息留在工具条上；
- 工具条新增 **「全屏」按钮**：调用 `document.documentElement.requestFullscreen()`，
  连侧边栏与顶栏一起收掉，并按 `fullscreenchange` 在「全屏 / 退出全屏」之间切换；
  浏览器不支持时明确提示「当前浏览器不支持全屏，可用 F11」，而不是点了没反应。

## 3. 决策

- **D1：满屏 ≠ 全屏 API，两者都做**。默认状态就让表格铺满可视区（不依赖任何浏览器权限），
  再给一个可选的真全屏按钮；只做后者的话，用户不点按钮时看到的仍是卡片。
- **D2：说明文字不删除，只降级**。静态说明移到 `title`、动态状态留在工具条 —— 满屏是把空间给表格，
  不是把信息藏起来。
- **D3：不改 AppShell**。`.content-area` 是全局布局，改它会影响几十个页面；用页面级负边距抵消，
  影响面收在这两个页面里。

## 4. 验证

见 `docs/log/2026-09-15.md` 的「第六轮」：`test/salary-page.test.tsx` 新增 3 条
（满屏类与结构、点全屏调用 requestFullscreen 且按钮文案切换、浏览器不支持时的提示），全套前端测试与
api 测试全绿。

## 5. 未验证

- 未在真实浏览器里量过像素：`100dvh` 与负边距的组合在不同浏览器/缩放/移动端软键盘弹出时的表现需要实机确认
  （CSS 里已给 `max-width:720px` 的窄屏单独调了边距）；
- 真全屏在 Safari 上只有部分支持（`webkitRequestFullscreen`），当前只走标准 API 并在不支持时提示。

## 6. 变更：改成悬浮居中窗口（同日稍后，用户改口）

> 「算了，工资台账和工资支付做成悬浮居中窗口页面吧，版面大一点。不追求全屏了」

- **删掉** `.page-fullscreen*` 一整组样式（负边距、`max-width:none`、`calc(100dvh - 顶栏)`）、
  浏览器全屏按钮与 `requestFullscreen` 逻辑（含不支持时的提示），以及 `fullscreenchange` 监听；
- **新增** `.page-floating` + `.floating-window`：内容区里居中一张大卡片
  （`width: min(1600px, 100%)`，比默认 1440 的内容区更宽；`height: calc(100dvh - 顶栏 - 84px)`，
  `min-height: 520px`，圆角 + 阴影）。卡片内只有工具条 + 筛选条 + 表格，纵向滚动交给表格；
- 卡片内的表格面板不再画第二层边框/底色（`.floating-window > .panel`），避免「卡片里再套一张卡片」；
- 加载态也放进窗口里（标题 + LoadingState），不再是「页头 + 空白」再跳变；
- 窄屏（≤900px）窗口高度改为随内容长，表格滚动区回到 `max-height: 60vh`；
- 测试同步**反向**断言：页面根带 `page-floating` 且**不带** `page-fullscreen`、
  `salary-floating-window` 存在、`salary-fullscreen-button` 不存在、加载态也在窗口内。
