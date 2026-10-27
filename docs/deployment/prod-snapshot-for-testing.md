# 生产快照取数（用于口径验证）

日期：2026-10-27
用途：阶段 6「把读路径从单号 join 换成 id join」的前后对照。mock 数据证不了「数字没变」，真实快照才行。

## 一条命令

```powershell
pwsh scripts/snapshot/fetch-prod-snapshot.ps1
```

四步：远端 `pg_dump`（只读）→ `scp` 回本地 → 灌进本地容器的新库 `dilee_snapshot` → 跑 `scripts/snapshot/desensitize.sql`。
重复取数用 `-SkipDump` 复用本地已有 dump；换库名用 `-LocalDb`。

## 这次抓到的规模

| 项 | 值 |
|---|---|
| 库大小 | 23 MB |
| dump 大小 | 1.2 MB |
| 销售单 / 采购单 / 生产单 | 43 / 95 / 7 |
| 客户 / 供应商 / 账号 | 11 / 90 / 35 |
| 审计事件 | 4578 行（快照里已清空） |

## 脱敏做了什么

| 对象 | 处理 |
|---|---|
| 客户、联系人、供应商 | 编码与名称换成 `客户-<id 前 8 位>`、电话换 13800000000、地址写「地址已脱敏」、备注清空 |
| 账号 | 用户名与显示名脱敏，`password_hash` 写 `disabled`（快照不能登录） |
| 员工 | 姓名脱敏，身份证号清空 |
| 附件 | 文件名与存储键脱敏，只留元数据形状 |
| JSONB 快照 | 顶层 `name/contact/phone/address/email` 换成「已脱敏」 |
| 审计事件、Agent 会话三表 | 清空（含自然语言原文） |

**没有处理**：业务单据的 `remark` 自由文本。快照只在本机用于口径验证，不要外发或提交。

## 用它验证阶段 6 的做法（已跑通）

1. **造一个已知口令的 laoban 账号**（快照里所有口令都被作废了）：
   ```powershell
   $hash = node -e "const a=require('argon2');a.hash('Baseline#2026',{type:a.argon2id}).then(h=>process.stdout.write(h))"
   docker exec dilee-postgres-1 psql -U dilee -d dilee_snapshot -c "UPDATE users SET username='baseline-laoban', password_hash='$hash' WHERE username='用户-64e1445b'"
   ```
2. **给快照补迁移**：生产库还没有本项目新增的 4 个迁移，缺列会让 Prisma 查询 500。
   ```powershell
   $env:DATABASE_URL="postgresql://dilee:<密码>@127.0.0.1:5432/dilee_snapshot?schema=public"
   cd apps/api; npx prisma migrate deploy --schema prisma/schema.prisma
   ```
3. **用快照起 API**（本机 3101，避免和开发环境冲突）：
   ```powershell
   $env:PORT=3101; node apps/api/dist/main.js
   ```
4. **抓基线**：`node scripts/snapshot/capture-finance-baseline.mjs before`
5. **改 join → 重启 → 再抓**：`node scripts/snapshot/capture-finance-baseline.mjs after`
6. **比对**：`node scripts/snapshot/compare-finance-baseline.mjs before after`（无差异退出码 0）

## 已抓到的基线（2026-10-27）

- 47 个财务接口：34 个 JSON + 13 个 xlsx，全部 200。
- 结果在 `docs/test/baselines/finance-before.json`（脱敏数据，可入库）。
- **两次抓取逐字节一致**：xlsx 只记工作表数与行数，因为导出件表头带「导出时间」。
  如果以后加了带时间戳的响应字段，对照会立刻报警——那是该字段要不要纳入口径的问题，不是抓取不稳。

## 顺带验证到的真实数据结论

在快照上跑完 4 个迁移后，回填效果（真实数据）：

| 表 | 行数 | 能落到销售单 |
|---|---|---|
| `purchase_receipts` | 4 | 4 |
| `incoming_inspections` | 4 | 4 |
| `raw_material_inbounds` | 4 | 4 |
| `payable_sources` | 4 | 4 |
| `inventory_facts` | 4 | 4 |
| `supplier_payments` | 43 | 2 |

`supplier_payments` 只有 2/43 能对上：付款单大多不挂订单号，这是预期，不是回填失败。

