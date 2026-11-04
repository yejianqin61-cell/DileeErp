# 抓包工件的时效说明

本目录下的 `captures/01..05` 在 **2026-10-26 22:30（修复合入后）** 被重新生成过一次，
因此 `02-plan-after-tool.json` / `03-stream-after-tool.json` 现在展示的是**修复后的单层编码**，
不再是缺陷现场。

缺陷发生时的原始 wire 字节仍逐字记录在上一级报告
[agent-sdk-wire-proof-2026-10-26.md](../agent-sdk-wire-proof-2026-10-26.md) §2.2 与 §2.3：

```text
"arguments":"\"{\\\"q\\\":\\\"SO-2026-0001\\\"}\""   ← 修复前（双重编码）
"arguments":"{\"q\":\"SO-2026-0001\"}"               ← 修复后
```

修复后重新抓包的结果（01..05 全部为单层编码、`JSON.parse` 得到对象）本身就是修复生效的证据；
如需缺陷现场，请从 git 历史检出 `8238430^` 之前的 provider 代码后重跑 `capture-wire.mjs`。
