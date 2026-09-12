# D5 浏览器验收与链路关闭证据

> 历史记录（2026-08-22）：以下验收结果反映当时的实现口径。计时单位已于 2026-09-12 全站改为**小时**（落库仍为分钟），员工日报也已改为**允许同一员工同日同工序多条**；本文中出现的「分钟」列等表述仅代表当日状态，不作为现行规则。

## 验收环境

- 独立 PostgreSQL：`dilee_erp_test`
- API：NestJS `http://localhost:3001`
- Web：Next.js standalone `http://localhost:3000`
- 浏览器：Playwright Chromium，单 worker

## 结果

命令：

```text
TEST_DATABASE_URL=postgresql://.../dilee_erp_test
PLAYWRIGHT_BASE_URL=http://localhost:3000
npx playwright test --reporter=line
```

结果：5/5 通过（认证 2、D5 日报 1、生产单 1、D4 原料流转 1），总耗时约 18.5 秒。

## D5 主旅程

1. 使用真实账号登录生产页面；
2. 录入工序完成量 6，服务端产生目标 5 的超单状态；
3. 录入计件 4 与计时 2/60 分钟员工日报，页面显示计件与计时参考金额；
4. 页面显示超单/差异告警及服务端累计，填写备注确认告警；
5. 既有 D3/D4 浏览器主旅程同时通过，未发现回归。

## 关闭边界

D5 不包含外加工现场日报、成品 QC/库存、最终薪资台账、工资支付、应收应付结算、全局告警中心、厂内部署和性能验收。
