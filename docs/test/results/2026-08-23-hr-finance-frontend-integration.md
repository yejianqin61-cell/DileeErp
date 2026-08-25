# 人事与财务前端联调阶段记录

- 日期：2026-08-23
- 代码基线：当前工作区
- 范围：人事与财务 Web 页面替换占位、真实 API 接入、Web 构建和 Docker 可访问性

## 已完成

- 人事页接入员工目录、考勤、绩效、薪资台账和工资支付 API。
- 人事页支持登记考勤、登记绩效、生成台账、确认/关闭台账和创建工资支付草稿。
- 财务页接入应收来源、收款、应付、付款和对账 API。
- 财务页支持确认应收/应付、创建收付款草稿、创建对账和处理对账。
- 财务页补充收款/付款草稿的分批过账核销和已过账冲销入口，调用现有后端分配接口。
- 两个页面已移除 `ModulePlaceholder`。

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| Web TypeScript 类型检查 | 通过 | `npm run typecheck --workspace=@dilee/web` |
| Web 生产构建 | 通过 | `npm run build --workspace=@dilee/web`；Docker 构建环境通过 |
| Docker Web 镜像重建 | 通过 | `docker compose ... build web` |
| Docker Web 容器重启 | 通过 | `dilee-web-1` Running |
| API 健康检查 | 通过 | `http://localhost:3000/api/v1/health` 返回 200 |
| 人事路由可访问 | 通过 | `http://localhost:3000/hr` 返回 200 |
| 财务路由可访问 | 通过 | `http://localhost:3000/finance` 返回 200 |

本轮本机 Next 构建曾受 Windows Node 堆内存不足影响；释放本地 dev/Playwright 进程后，Docker 生产构建通过。期间发现 standalone Next 容器宿主机访问为空响应，已在 `apps/web/Dockerfile` 固定 `HOSTNAME=0.0.0.0` 并重建验证。

重建后的厂内部署验证：宿主机 `/login` 返回 200，登录返回 201，财务支付/应付列表和人事薪资列表均返回 200。

## 联调缺陷与修复

首次浏览器访问财务页时，`customer-payments` 和 `payable-entries` 返回 500。API 日志确认原因为数据库迁移缺少 Prisma schema 已声明的关系列：`customer_payments.sales_order_id`、`supplier_payable_entries.purchase_order_id`、`purchase_order_item_id` 和 `outsource_logistics_batch_id`。

已新增 `20260823100000_finance_source_relation_columns` migration，并为 Prisma 字段补齐 snake_case 映射。重建 API、执行厂内 migration 并重启容器后，使用登录会话逐个验证：

| 接口 | 结果 |
| --- | --- |
| `/api/v1/finance/receivable-sources` | 200，空数据 |
| `/api/v1/finance/customer-payments` | 200，空数据 |
| `/api/v1/finance/payable-entries` | 200，空数据 |
| `/api/v1/finance/supplier-payments` | 200，空数据 |
| `/api/v1/finance/reconciliations` | 200，空数据 |
| `/api/v1/hr/attendance-records` | 200，空数据 |
| `/api/v1/hr/performance-records` | 200，空数据 |
| `/api/v1/hr/payroll-ledgers` | 200，空数据 |
| `/api/v1/hr/salary-payments` | 200，空数据 |

## 写入型人事联调

使用唯一前缀的临时部门、岗位和员工 fixture，通过登录后的真实 HTTP API 完成并验证：

- 创建部门、岗位和员工；
- 登记考勤；
- 登记绩效；
- 生成并确认月度薪资台账；
- 清理临时考勤、绩效、台账、员工、岗位和部门数据。

结果：上述请求均成功，fixture 已清理。

## 写入型财务联调

使用唯一前缀的临时客户和供应商 fixture，通过登录后的真实 HTTP API 完成并验证：

- 创建客户和供应商；
- 创建收款草稿；
- 创建付款草稿；
- 通过列表接口重新读取两类支付记录；
- 清理临时支付、客户和供应商数据。

结果：收款和付款草稿均成功创建并返回 `draft`，fixture 已清理。由于当前库没有成品出库或原料入库事实，本轮未伪造应收/应付来源，因此确认、核销和冲销仍需在对应业务链路 fixture 完整后验收。

## 尚未完成

- 尚未使用专用测试数据库和真实业务 fixture 完成登录后的浏览器写入、分批核销和冲销验收；本轮已通过登录 HTTP 会话完成临时 fixture 写入验证。
- 收款/付款的分批核销、冲销和权限边界尚未完成前端 E2E 覆盖。
- 人事员工目录的新增/编辑仍依赖生产主数据页面，当前人事页先提供读取和业务记录操作。
- 需要业务负责人确认字段、币种、支付方式和对账状态展示口径。

## 阶段结论

人事与财务已从前端占位进入真实 API 联调阶段，构建和容器路由验证通过；尚不能标记为完整业务链路验收完成，下一步应补充专用测试数据和登录后的 Playwright 验收。
