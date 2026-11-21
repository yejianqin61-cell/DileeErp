# 老旧浏览器兼容（Windows 10 以下 / 旧内核浏览器）

> 变更日期：2026-11-21。相关代码：`apps/web/lib/legacy-compat.ts`、`apps/web/app/layout.tsx`。
> 守卫测试：`apps/web/test/legacy-compat.test.tsx`（18 项）。
> 真实浏览器验证：`node scripts/legacy-browser-check.mjs`。

## 一句话结论

**不是所有旧浏览器都能救。**

- **能救的**：Chrome / Edge 80 及以上（含 Windows 7 上的 Chrome 109）。兼容层补齐了它们缺的 API，功能完整可用。
- **救不了的**：IE 11、以及 360 / QQ / 搜狗的「兼容模式（IE 内核）」。React 19 + Next.js 15 不可能跑在 IE 上。
  这类浏览器现在**不再白屏**，而是显示一张中文说明页，明确告诉用户换哪个浏览器。

## 真正的故障点（实测，不是猜）

诊断顺序与结论：

| 检查 | 结果 | 判断 |
|---|---|---|
| Tailwind CSS？ | **不在用**（样式是手写 CSS + CSS 变量） | 排除了「Tailwind v4 要求 Chrome 111」这个最大嫌疑 |
| 构建产物语法底线 | 含 `?.` / `??`，不含逻辑赋值 / 私有字段 / 静态块 | **Chrome 80** |
| `Object.groupBy` / `toSorted` / `withResolvers` 等 | 产物的命中都是第三方库自己的同名方法（如 ZRender 的 `OrderedDict`），**不是**原生方法 | 不是阻塞点 |
| **`AbortSignal.timeout`** | 我们自己代码用了 **6 处**，`lib/api-client.ts` **每次请求**都用 | **Chrome 103+ / Firefox 100+ / Safari 16+**。这是真正的元凶 |

所以：

- **Chrome 80~102**：页面能渲染，但**每个接口请求都抛 `TypeError: AbortSignal.timeout is not a function`** —— 登录都登不进去。这就是"打不开"的最常见原因。
- **Chrome 60~79**：有 Promise/fetch/AbortController（常规探测全过），但解析不了 `?.`/`??` → 脚本在**解析阶段** SyntaxError → 静默白屏、连提示都没有。
- **IE 11**：整个脚本语法错误 → 纯白屏。

## 兼容层做了什么

文件：`apps/web/lib/legacy-compat.ts`，由 `app/layout.tsx` **内联注入 `<head>`**。

### 1. 补 API（每项都有 `if (!X)` 守卫，绝不覆盖原生实现）

| API | 原生要求 | 为什么补 |
|---|---|---|
| `AbortSignal.timeout` | Chrome 103 | **关键**：不补则所有接口挂 |
| `AbortSignal.any` | Chrome 116 | 组合取消信号 |
| `Array.prototype.at` / `String.prototype.at` | Chrome 92 | 产物里有 4 处 |
| `Object.hasOwn` | Chrome 93 | — |
| `Array.prototype.findLast` / `findLastIndex` | Chrome 97 | — |
| `String.prototype.replaceAll` | Chrome 85 | 源码 5 处 |
| `Object.groupBy` / `Map.groupBy` | Chrome 117 | — |
| `toSorted` / `toReversed` / `toSpliced` / `with` | Chrome 110 | — |
| `Promise.withResolvers` | Chrome 119 | — |
| `URL.canParse` | Chrome 120 | 产物有 2 处（Next 自己也补了一份，这里兜底） |

### 2. 语法能力探测（这一项容易被忽略）

用 `try { new Function(code) } catch {}` 在运行时试解析：

- 解析不了可选链 → 记为缺失；
- 解析不了空值合并 → 记为缺失。

这样 Chrome 60~79 不再静默白屏，而是走"不支持"提示。

探测串用 `String.fromCharCode(63)` 拼出运算符，**源文件里不出现这两个运算符字面量** —— 一是保持守卫测试严格（保证 IE11 能解析本脚本），二是本文件是模板字符串，混入特殊符号容易出语法错。

### 3. 兜底提示页

缺不可 polyfill 的底座（`Promise` / `Symbol` / `Map` / `fetch` / `CSS 变量` / `Element.closest` 等）或语法探测失败时，渲染一张全屏中文说明：

- 列出**缺了哪几项**（便于反馈时截图）；
- 给出**具体浏览器版本建议**（Win10/11 → Edge/Chrome 最新；Win7/8.1 → Chrome 109；360/QQ/搜狗 → 切极速模式；IE → 不可用）；
- 附带 UA 字符串。

**样式全部内联**（`style="..."`），因为旧浏览器可能不支持外部 CSS 的某些写法。

## 两个硬约束（改这个文件前必读）

1. **注入的脚本文本必须是 ES5**：它要在 IE11 上也能**解析**，否则连兜底提示都显示不出来。
   不许出现箭头函数、`let`/`const`、`class`、模板字符串、展开运算符、`?.`、`??`。
   `test/legacy-compat.test.tsx` 有 4 条守卫用例专门拦这个（正则 + 真实 `new Function` 解析双重校验）。
2. **必须内联在 `<head>`、先于打包产物执行**：用 `import` 保证不了顺序（供应商 chunk 可能先加载），
   所以由 `layout.tsx` 直接 `dangerouslySetInnerHTML` 注入。

> 补充事实：Next 会在 `<head>` 里插入一批 `async` 的 chunk 脚本，位置在兼容脚本**之前**。
> 这不影响正确性 —— 因为 ① `async` 脚本不阻塞解析，内联脚本会先执行完；
> ② 我们所有 `AbortSignal.timeout` 调用都在**函数体内**（`api-client.ts:17/29`、`download.ts:39/66/94`），
> 加载期不调用。已核实源码中没有「模块顶层 `const x = AbortSignal.timeout(...)`」这类写法。

## 支持矩阵

| 浏览器 | 结果 | 说明 |
|---|---|---|
| Chrome / Edge 103+ | ✅ 完全可用 | 无需 polyfill |
| Chrome / Edge **80~102** | ✅ **本次修复** | 之前接口全挂，现在完整可用 |
| Chrome / Edge 60~79 | ⚠️ 显示换浏览器提示 | 语法不支持，不可修复 |
| **Chrome 109（Windows 7 最高版）** | ✅ 完整可用 | 这是 Win7 用户的正解 |
| Firefox 78+ | ✅ 可用 | `AbortSignal.timeout` 是 Firefox 100+，已补 |
| Safari 14+ | ✅ 可用 | 同上 |
| IE 11 / 360 兼容模式 | ❌ 不可用 | 显示提示页，请改用极速模式或换浏览器 |

## 验证方式（两种，都必须跑）

```bash
# ① 逻辑与语法守卫（18 项）
cd apps/web && npx vitest run test/legacy-compat.test.tsx

# ② 真实浏览器验证（需要先起 standalone 服务在 3002）
npm run build --workspace=@dilee/web
# 按部署脚本的布局复制静态资源，否则 chunk 全 404、页面不会真正跑起来
cp -r apps/web/.next/static apps/web/.next/standalone/apps/web/.next/
cp -r apps/web/public apps/web/.next/standalone/apps/web/
PORT=3002 node apps/web/.next/standalone/apps/web/server.js &
node scripts/legacy-browser-check.mjs
```

`scripts/legacy-browser-check.mjs` 覆盖三种场景：Chrome 102 级、Chrome 80 级、IE 级。
断言包括：不白屏、polyfill 真的补回、**带 `AbortSignal.timeout` 的真实请求能拿到 200**、IE 场景必须出现提示页。

### 已经做过的强度更高的验证

**因果链验证**（真实 Chromium）：删掉 API → 调用抛 `TypeError: AbortSignal.timeout is not a function`
→ 执行兼容脚本 → 同一调用恢复 `HTTP 200`、`AbortSignal.any` 生效。

**变异验证**：把「可选链探测」从兼容层里删掉，`legacy-compat.test.tsx` 立即变红；
恢复后全绿 —— 证明那条守卫不是空转。

## 踩过的坑（别再踩）

1. **本地起 standalone 服务必须复制 `.next/static` 与 `public/`**。漏了的话所有 chunk 404，
   页面只有 SSR 文字、React 从不启动。这种状态下"不白屏"的结论**是假的** —— 第一次验证就栽在这里，
   被"13 条 console 错误」和对照组同一个错误数"识破。
2. **`successfully` 的假绿灯**：`delete AbortSignal.timeout` 在 `data:text/html` 页面上生效，
   但在 Next 页面上会因为 HTML 里存在多份内联脚本副本而失效。改用「在真实页面里删 API 再执行脚本」
   的因果链方式验证，比拦截改写 HTML 可靠。
3. **模板字符串里不能出现反引号**：`legacy-compat.ts` 的脚本体是模板字符串，
   注释里写反引号会提前终止字符串，报 `Tagged template expressions are not permitted in an optional chain`。