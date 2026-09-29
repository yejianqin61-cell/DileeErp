# 新建销售单必然 400「请求参数校验失败」——根因与修复（2026-09-20）

用户报告：**新建销售单时总是显示「请求参数校验失败」**，而且看不出是哪一格错了。

---

## 1. 根因（已复现）

**只填必填项 → 必然 400。** 复现脚本把「新建销售单」整页编辑器真实发出的载荷过一遍真实
`ValidationPipe`，得到 10 条错误，全部落在 5 个布量字段上：

```
- fabric_usage_canopy [isDecimal] fabric_usage_canopy is not a valid decimal number.
- fabric_usage_canopy [matches]   布量必须是不小于 0 的十进制数
- …（伞带 / 木耳 / 天布 / 布套 各两条）
```

成因是一条**两条规矩互相咬住**的链路：

1. 前端 `lib/sales-order-spec.ts` 的 `specPayload()` **把 37 个细化键全部带上**（不填的给空串）。
   这是**有意**的：不带键就永远清不掉一格（后端 `specScalars` 用「传了 null/空串 = 清空」表达
   删除这一格），所以不能靠「前端别发空键」来绕。
2. 后端 `SalesOrderSpecDto` 里，**37 格里只有 5 个布量是数值列**：
   `@IsOptional() @Matches(NON_NEGATIVE_DECIMAL) @IsDecimal()`。
   而 `@IsOptional()` **只跳过 `null` / `undefined`** —— 空串照样会被送进 `@Matches` / `@IsDecimal`，
   判成「不是合法小数」。

于是「布量一个字都不填」这种**最常见的填法**每次都 400。文本列没事（`@IsString()` 放行空串，
服务层再把 `""` 落成 NULL），所以这个问题只在 5 个布量上发作 —— 而它们恰好默认全空。

`SalesOrderSpecDto` 的类注释当时写着「故意不加 `EmptyStringToUndefined`」，理由是空串语义是
「清除这一格」；这条理由**对文本列成立、对数值列不成立**：数值列连校验都过不去，根本走不到服务层。

## 2. 修复

### 2.1 新增 `EmptyStringToNull`（`platform/http/empty-string-to-null.decorator.ts`）

把空串（含纯空白）转成 **`null`**：

- `@IsOptional()` 同样跳过 `null` → 校验能过；
- 服务层 `specScalars` 把 `null` 原样落库 → **仍是「清除这一格」**，不是「不动」。

这一点是关键：改用现成的 `EmptyStringToUndefined` 也能让校验通过，但语义会变成「不修改」——
用户把一格删空再保存，值还在，看着像保存失败。两个装饰器的差别正好是相反的两个后果。

只加在 5 个布量字段上（`sales-orders.controller.ts`），文本列保持原样。
`SpecScalarFields` 的类型相应放宽为 `string | null`（否则控制器把 DTO 交给服务时编译期就红）。

### 2.2 嵌套字段的校验错误不再丢（recon D10）

用户「看不出哪一格错」不是偶然：全局 `ValidationPipe` 的 `exceptionFactory` 原来只读顶层
`error.constraints`，而 `@ValidateNested()` 的错误挂在 `error.children` 上 → **嵌套字段校验失败时
`details` 是空数组**。于是「明细数量填了 abc」「明细缺品名」「未知字段」「必填为空」四种完全不同的
原因，在界面上长得一模一样（都是「请求参数校验失败」）。

修复：抽成 `platform/http/validation-exception.factory.ts`（抽出来才能被单测直接调用，放在
`main.ts` 的 bootstrap 里永远测不到），递归 `children` 并把数组下标拍成 `spec_details[1].quantity`。
顶层字段的旧形状**一个字没变**（`{ field, rule, message }`，顺序保持），
`contract-guardrails.test.cjs` 的 D10 护栏用例已从「断言 details 为空」翻转为
「断言能定位到 `items[n].xxx`」。

### 2.3 界面把 details 显示出来

`apps/web/lib/api-error-text.ts`（新）+ 销售单编辑器改用它：失败提示从
「请求参数校验失败」变成「请求参数校验失败：数量：明细数量必须是不小于 0 的十进制数」。
字段路径会做人话化（`spec_details[0].quantity` → 「数量」），表里没有的键**原样显示**
（宁可让用户看到 `fabric_usage_canopy`，也不要吞掉这条错误）。
非信封错误（网络中断）仍走页面自己的兜底文案。

## 3. 回归护栏

| 用例 | 钉住什么 |
|------|----------|
| `apps/api/test/unit/sales-order-dto.test.cjs` 的「字段清单不许分叉」 | 从 `apps/web/lib/sales-order-spec.ts` **源码里抽出** 37 个键，与后端 `SPEC_SCALAR_FIELDS` 逐键按序比对。清单分叉的后果是「界面填了、库里没存」，而这次 400 之所以能长期潜伏，正是因为契约测试里的 `dialogBody` 是**旧的弹窗载荷**（没有那 37 个键） |
| 同上「整页编辑器：只填必填项、37 个细化格全空」 | 现场真实载荷必须通过；布量空串必须归一成 `null`（清空），文本格保持空串 |
| 同上「布量填了非法值仍然 400」 | 空串归一**没有**放松校验（`abc` / `-1` / `1e3` 仍被拒） |
| 同上「编辑：清空布量 = 清空这一格」 | `null` 而不是 `undefined`，别退回「不动」 |
| `apps/api/test/unit/validation-exception-factory.test.cjs`（6 条） | 路径拼接（`a.b[1].c`）、顶层旧形状、一个节点同时有 constraint 与 children 时不互相吞、真实 ValidationPipe 端到端 |
| `apps/web/lib/sales-order-spec.test.mjs` 新增 1 条 | 前端照发空串是**契约**（不是可以「聪明地」省略的），后端必须收得下 |
| `apps/web/lib/api-error-text.test.mjs`（6 条） | 结构化业务 details（如 `{ available: "3" }`）不会被当成错误提示；非信封错误退回 fallback |
| `contract-guardrails.test.cjs` D10 | 见 §2.2 |

## 4. 未做的事

- **没有把 `apiErrorText` 铺到全站**：目前只改了销售单编辑器（本次问题所在）。
  其余页面仍只显示 `cause.message`，它们同样会丢掉 `details`。建议后续统一替换 —— 
  这次先把「可复用的翻译层 + 测试」建好，避免一次改几十个页面时把语气改乱。
- **`api-exception.filter.ts` 里「message 是数组 → 通用文案」的老分支保留**：
  那是 Nest 内置异常（非本仓库 DTO）的兜底，删掉会让某些 400 变回英文原文。
