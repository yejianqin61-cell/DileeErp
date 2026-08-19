# 前端任务 01：Design Token 与 shadcn/ui 基础

## 状态
待认领

## 依赖
无。

## 目标

建立 ERP 前端统一的 design token 和 shadcn/ui 基础组件约定，作为所有占位页面的视觉与交互基础。

## 范围

- CSS variables 或等效 token：背景、内容面、边框、文字、主色、成功/警告/错误/信息。
- 固定间距阶梯、字体层级、控件高度、表格行高、侧栏宽度、圆角和阴影。
- shadcn/ui 基础组件初始化：按钮、输入、标签、分隔线、下拉菜单、表格承载所需组件。
- focus、hover、disabled、loading、error、selected 状态。

## 非范围

不定义品牌营销视觉、模块业务状态颜色映射或移动端断点策略。

## 验收与验证

- 所有新增 UI 不直接散落重复颜色和尺寸常量。
- 基础组件在中文桌面界面下文字不溢出。
- `npm run typecheck --workspace=@dilee/web` 和 `npm run build --workspace=@dilee/web` 通过。
