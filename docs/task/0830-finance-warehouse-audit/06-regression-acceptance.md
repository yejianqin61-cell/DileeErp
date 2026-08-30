# 06 跨模块回归与权限验收

**Status:** completed

## 验证结果

- API 构建通过。
- Web 类型检查通过。
- `npm run test:unit`：67/67 通过。
- 真实 PostgreSQL、HTTP 和 Playwright 验收仍需配置专用环境后执行。
**Priority:** P1
**Depends on:** 01-05

## 目标

用专用 PostgreSQL、登录会话和浏览器验收完整财务/仓库链路。

## 交付

- API 单元、集成、HTTP 合约和 Playwright 覆盖。
- 采购/仓库/财务权限边界、幂等、回退、负库存和金额超额校验。
- 记录真实环境验收结果；环境缺失时明确阻断，不以构建通过代替验收。
