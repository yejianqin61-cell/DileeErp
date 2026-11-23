<task-brief>

## 1. Where this task sits

- **Phase P1 止血**，目标是工具调用失败率归零、通过率不退。
- **本任务交付 R-1 服务端单号归一**：全角、多余空白、零宽字符在服务端一次做对，不再靠模型代劳。
- **Starts after**：无。**Waits on it**：任务 2、3、5。

## 2. What the developer needs to know

**Read first**

- `apps/api/src/modules/business-query-agent/tools/normalize.ts` — 现在只做 trim + 合并空白，大小写交给 SQL 的 `insensitive`。
- `apps/api/src/modules/business-query-agent/tools/order-root.ts` — 两段匹配（精确 → insensitive），归一后的值从这里进库。
- `docs/review/agent-golden-baseline-2026-11-22.md` §7 — 证据：全角用例通过，是因为模型自己把 `ＭＯＣＫ－ＯＲＤ－００１` 转成了半角。

**Settled**

- 只改**比对用**的值，不改库里的业务单号。单号里的空格与产品名是真实内容。
- 不做拼音、同音字、模糊纠错：那会把「查不到」变成「查到一张像的单」，对财务场景更危险。
- 不引入依赖。全角折叠是一张码点映射表，手写 30 行足够。

**Edges and seam**

- Touches `tools/normalize.ts` 一个文件；调用方（`parseSearchOrdersInput`、`parseSearchDocumentsInput`、`assertOrderRoot`、`parseOrderRootInput`）已经都在用它。
- 不动 SQL 查询形状，不动 Prisma。

**Run**

- `node --test apps/api/test/unit/agent-normalize.test.cjs`（本任务新建）
- `npm run build --workspace=@dilee/api`

**Unknowns**

- 全角连字符 `－` 与全角空格 `\u3000` 是否都要折叠？按 Unicode 的 FW→ASCII 区间统一处理即可；若发现某个字符属于业务单号的合法内容（例如中文括号），停下来报告，别硬折叠。

## 3. The workflow

1. 读三个文件，一句话复述本任务。
2. 先写失败测试：`ＭＯＣＫ－ＯＲＤ－００１` 归一后等于 `MOCK-ORD-001`；`\u3000MOCK\u3000ORD-001 ` 归一后等于 `MOCK ORD-001` 的空白合并结果。
3. 实现 `normalizeKeyword`：零宽字符删除 → 全角转半角（U+FF01–FF5E 减 0xFEE0，U+3000 转空格）→ trim → 合并连续空白。
4. 补测试：普通半角单号原样返回；中文与产品名不被改动。
5. 跑单测与 api build，提交。

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | `ＭＯＣＫ－ＯＲＤ－００１` | `MOCK-ORD-001` | `normalizeKeyword()` |
| 2 | `　MOCK-ORD-001　`（全角空格包裹） | `MOCK-ORD-001` | `normalizeKeyword()` |
| 3 | `MOCK-ORD-001\u200b`（零宽空格） | `MOCK-ORD-001` | `normalizeKeyword()` |
| 4 | `MOCK  ORD-001`（双空格） | `MOCK ORD-001` | `normalizeKeyword()` |
| 5 | `伞布-蓝色（模拟）` | 原样 | `normalizeKeyword()` |
| 6 | `DL260170-4H 伞头` | 原样（空格是真实内容） | `normalizeKeyword()` |

</task-brief>