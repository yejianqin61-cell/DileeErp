# 链路质量门禁结果

- 提交：`4802a80`
- 时间：2026-08-21T07:00:22.418Z
- 环境：真实测试库/API/浏览器，缺失时明确阻断

| 命令 | 退出码 | 结果 |
| --- | ---: | --- |
| `npm run db:test:prepare` | 3 | 环境阻断 |
| `npm run test:integration` | 3 | 环境阻断 |
| `npm run test:api` | 3 | 环境阻断 |
| `npm run test:e2e` | 3 | 环境阻断 |

## 诊断摘要

### npm run db:test:prepare

```text
> dilee-erp@0.1.0 db:test:prepare
> node scripts/prepare-test-database.mjs

TEST_BLOCKED: TEST_DATABASE_URL must point to a dedicated test database
```
### npm run test:integration

```text
> dilee-erp@0.1.0 test:integration
> node scripts/run-tests.mjs integration

TEST_BLOCKED: TEST_DATABASE_URL is required for PostgreSQL integration tests
```
### npm run test:api

```text
> dilee-erp@0.1.0 test:api
> node scripts/run-tests.mjs api

TEST_BLOCKED: API_BASE_URL is required for HTTP API tests
```
### npm run test:e2e

```text
> dilee-erp@0.1.0 test:e2e
> node scripts/run-tests.mjs e2e

TEST_BLOCKED: PLAYWRIGHT_BASE_URL is required for browser tests
```
