# 「迪礼顾问」/business-query 真实 Chromium 只读视觉验证报告

- 结论：**通过**。8 个场景、113 条断言全部通过；所有场景 0 条 console error、0 条 pageerror。
- 环境：Next.js 15.5.23（`next dev -p 3111`）+ 真实 Chromium（Playwright 1.62.1 headless，`serviceWorkers: "block"`）。
- 数据：所有 `/api/v1/**` 由 `page.route` 按页面真实契约 mock（JSON 信封 `{data, meta}`、SSE 版本化事件帧），**未改任何仓库源码**。
- 覆盖：桌面 1440x900 / 窄屏 390x844；空态 / 对话 / 回看历史 / 流式 / 失败 / 历史弹窗。
- 说明：本报告是 Lead 修完「流式光标独立占行」与「390px 侧栏压扁对话」之后的**收尾复验**；全部截图已用新代码重新生成（路径不变）。

## 1. 截图清单（绝对路径）

| 截图 | 证明什么 |
| --- | --- |
| `C:\Users\USER\Desktop\Dilee\docs\test\results\agent-chat-ui\desktop-empty.png` | 桌面空态：AI 图标 + 标题 + 副标题 + 4 张推荐卡；整页不滚，输入区固定底部 |
| `C:\Users\USER\Desktop\Dilee\docs\test\results\agent-chat-ui\desktop-conversation.png` | 桌面 2 轮对话：用户右侧浅色气泡、AI 左侧无气泡 Markdown（含表格/列表）、来源 chips + 复制，输入框在视口内 |
| `C:\Users\USER\Desktop\Dilee\docs\test\results\agent-chat-ui\desktop-scrolled.png` | 消息区滚到顶部回看历史时，右下/底部中央出现「回到底部」圆钮，整页仍不滚 |
| `C:\Users\USER\Desktop\Dilee\docs\test\results\agent-chat-ui\desktop-streaming.png` | 流式态：折叠的执行步骤「正在查询销售订单」+ 流式正文 + 光标贴着最后一个字 + 停止按钮 |
| `C:\Users\USER\Desktop\Dilee\docs\test\results\agent-chat-ui\desktop-error.png` | 失败态：`AGENT_RUN_TIMEOUT` 未完成原因（红字）+ 「重试」按钮，部分答案仍可复制 |
| `C:\Users\USER\Desktop\Dilee\docs\test\results\agent-chat-ui\desktop-history.png` | 历史记录弹窗：2 条会话（标题取各会话首问）+ 更新时间/轮数 |
| `C:\Users\USER\Desktop\Dilee\docs\test\results\agent-chat-ui\mobile-empty.png` | 390px 空态：ERP 侧栏已隐藏、对话占满 390px、工具栏有「回工作台」图标、无横向溢出 |
| `C:\Users\USER\Desktop\Dilee\docs\test\results\agent-chat-ui\mobile-conversation.png` | 390px 对话：正文满宽正常换行（不再一字一行）、表格内部横滑、输入区完整可见 |

## 2. 实测数字

### 桌面 1440x900（6 个场景一致）

| 指标 | 实测 |
| --- | --- |
| `document.scrollingElement.scrollHeight` / `window.innerHeight` | 900 / 900，**差 0**（整页不可滚） |
| `document.documentElement.scrollWidth` / `window.innerWidth` | 1440 / 1440，**差 0**（无横向溢出） |
| `[data-testid="agent-scroll"]` clientHeight / scrollHeight | 空态 653/653；对话 653/852（scrollTop 199，自动贴底）；回看 653/852（scrollTop 0）；流式 653/653；失败 653/653；历史 653/852 |
| thread（`.agent-thread`）left / right | 436 / 1236 |
| 用户气泡 right（2 条） | **1236 / 1236 = thread.right**（右对齐） |
| AI 正文 left（2 条） | **476 / 476 = thread.left + 40px**（28 头像 + 12 间距，左侧无气泡） |
| AI 正文 computed background | `rgba(0, 0, 0, 0)` ×2（无气泡）；用户气泡 `rgb(232, 242, 245)` |
| 输入框 rect | top 784 / bottom 812（≤ 900）；发送/停止按钮 bottom 852（≤ 900） |
| 消息区下沿 − 输入区上沿 | **0px**（0 重叠，输入区固定在工作区底部）；输入区底边距视口底 0px |
| `.sidebar` computed display | **block**（桌面侧栏未被误伤）；`.topbar` display flex、可见 |
| `[data-testid="agent-toolbar-home"]` | display **none**（桌面按预期隐藏） |
| Markdown 表格外层 clientWidth / scrollWidth | 758 / 758（桌面 3 列表格放得下，无需内部横滑） |
| 顶栏 / 侧栏 boundingBox | 顶栏 232,0,1208x56；侧栏 0,0,232x900（均在视口内） |
| 历史弹窗 rect | 144,334 → 1296,566（1152x232，视口内居中） |

### 窄屏 390x844（修复后）

| 指标 | 实测 |
| --- | --- |
| `.sidebar` computed display | **none**（仅 /business-query 隐藏侧栏） |
| `[data-testid="agent-toolbar-home"]` | display **grid**，可见；rect 12,66.5,28x28 |
| 工具栏标题 right / 动作区 left | 140.8 / 198（**不重叠**，留 57.2px 间隙） |
| `document.documentElement.scrollWidth` / `innerWidth` | 390 / 390，**差 0**（无横向溢出，≤ 390+1） |
| `scrollingElement.scrollHeight` / `innerHeight` | 844 / 844，**差 0**（整页不滚） |
| `[data-testid="agent-scroll"]` clientHeight / scrollHeight | 空态 **576/576**（scrollTop 0，空态完整可见）；对话 **576/1198**（scrollTop 622 自动贴底，**clientHeight 576 > 300**） |
| AI 正文宽度（2 条） | **326 / 326 px**（修复前 88px 一字一行 → 现在正常换行） |
| 用户气泡 right（2 条） | 378 / 378 = thread.right；thread left/right 12/378 |
| AI 正文 left（2 条） | 52 / 52 = thread.left + 40px |
| 输入框 rect | top 697 / bottom **749 ≤ 844**；发送按钮 bottom 789 ≤ 844（不被裁掉） |
| Markdown 表格外层 clientWidth / scrollWidth | **324 / 378（内部横滑）**，页面 scrollWidth 仍 390（宽表不撑破页面） |

### 流式场景（desktop-streaming）

| 指标 | 实测 |
| --- | --- |
| `[data-testid="agent-stream-caret"]` | 存在，**在最后一个 `.agent-md-p` 内**（`caretInLastParagraph=true`） |
| caret `getBoundingClientRect()` | left 1176.6 / right 1183.6 / **top 268.9** / **bottom 284.2**（7 x 15.2） |
| 最后段落 rect | left 476 / right 1236 / **top 265** / **bottom 290.8** |
| 同线判断 | caret 纵向 268.9–284.2 完全落在段落 265–290.8 内；水平 1176.6 紧贴最后一行文字「已出货。」之后 → **不再单独占一行** |
| 其他 | 折叠步骤摘要文案 `正在查询销售订单`（1 张，默认折叠）；停止按钮 `business-query-cancel` 可见；阶段文案 `连接中断，正在恢复…`（见 §4.e） |

### 断言与控制台

| 场景 | 断言 | console error | pageerror |
| --- | --- | --- | --- |
| desktop-empty | 12/12 | 0 | 0 |
| desktop-conversation | 25/25 | 0 | 0 |
| desktop-scrolled | 9/9 | 0 | 0 |
| desktop-streaming | 14/14 | 0 | 0 |
| desktop-error | 9/9 | 0 | 0 |
| desktop-history | 11/11 | 0 | 0 |
| mobile-empty | 14/14 | 0 | 0 |
| mobile-conversation | 19/19 | 0 | 0 |
| **合计** | **113/113** | **0** | **0** |

## 3. 复验要点（Lead 指定）

- 手机 390x844：`.sidebar` display = `none` ✅；`agent-toolbar-home` 可见（grid, 28x28）✅；`scrollWidth` 390 ≤ 391 ✅；输入框底边 749 ≤ 844 ✅。
- 手机对话：正文宽 326px（不再一字一行）✅；`agent-scroll` clientHeight 576 > 300 ✅。
- 桌面 1440x900：`.sidebar` display = `block`（未误伤）✅；顶栏可见 ✅；`scrollHeight - innerHeight = 0 ≤ 1` ✅。
- 流式：caret 存在且在最后段落内、纵向落在段落 rect 范围内 ✅（数字见上）。

## 4. 肉眼检查（未改源码，仅记录）

a. 没有两个大彩色气泡：AI 正文 computed background 全透明，只有用户消息右侧浅色气泡；间距、字号正常。
b. 没有布局溢出 / 滚动冲突：桌面整页差值 0，只有消息区滚；输入区与消息区交界 0px，不遮挡消息。
c. 窄屏修复有效：侧栏退场后工具栏不再互相压；390px 无横向溢出；宽表在表格内部横滑而不是撑破页面。
d. 轻微/既有现象（非本次页面引入）：顶栏右上用户区在 1440px 也呈两行（「张」头像一行、姓名+角色一行）——全局 `.user-menu-account` 里 block 级 `.user-dot` 造成折行，其它 ERP 页同样如此；「回到底部」是悬浮圆钮，会盖住其下方一行正文（desktop-scrolled 可见，属预期悬浮行为）；窄屏空态输入框因占位文字折行被自动增高到 52px（两行），仍不溢出；截图左下黑色 N 圆点是 Next dev 指示器，不是页面元素。
e. 流式阶段文案显示「连接中断，正在恢复…」而不是「正在回答…」：按任务契约，mock 的 SSE 在 2 个 answer_delta 后直接结束且**不发终态事件**，页面据此进入自动重连续接（保持运行态、停止按钮可用）。这是 mock 设计的结果，不是页面缺陷；Playwright `route.fulfill` 无法保持长连接，若要截到「正在回答…」需真实后端 SSE。

## 5. 过程记录 / 失败与恢复

- 首次全量跑通后，Lead 的 `next build` 与我的 dev server 同时写 `apps/web/.next`，dev server 报 500，原始错误：
  - `Error: ENOENT: no such file or directory, open '...\apps\web\.next\server\app-paths-manifest.json'`
  - `Error: ENOENT: no such file or directory, open '...\apps\web\.next\routes-manifest.json'`
- 处理：只停止/重启 dev server（未清理、未改动 `.next` 与任何源码），重启后 HTTP 200 恢复，再全量重跑；HMR 已编译 Lead 的光标/侧栏改动（dev 日志可见 `✓ Compiled`）。
- dev server 最终状态：**已关闭**，3111 端口已释放（见交付消息中的端口检查输出）。

## 6. 复现方式

```powershell
# 1) 起 dev server
npm run dev --workspace=@dilee/web -- -p 3111
# 2) 跑验证（脚本会覆盖 docs/test/results/agent-chat-ui/*.png 并写 .agent/verify/results.json）
node .agent\verify\visual-check.mjs
```

- 脚本：`C:\Users\USER\Desktop\Dilee\.agent\verify\visual-check.mjs`
- 原始指标：`C:\Users\USER\Desktop\Dilee\.agent\verify\results.json`
